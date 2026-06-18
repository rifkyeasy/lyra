'use client'

import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
} from 'framer-motion'
import Link from 'next/link'
import { useEffect, useState } from 'react'

type NavChild = { label: string; desc: string; href: string; external?: boolean }
type NavEntry = { label: string; href?: string; featured?: NavChild; items?: NavChild[] }

const NAV: NavEntry[] = [
  {
    label: 'Product',
    featured: { label: 'Open console', desc: 'Direct your agent by chat — live', href: '/console' },
    items: [
      { label: 'Console', desc: 'Direct your agent by chat', href: '/console' },
      { label: 'Playground', desc: 'Try the agent, no wallet needed', href: '/playground' },
      { label: 'Agents', desc: 'Browse Sui agents', href: '/console/agents' },
    ],
  },
  {
    // Everything a builder needs: docs, the published CLI/SDK, and source.
    label: 'Developers',
    items: [
      { label: 'Docs', desc: 'What Lyra is, end to end', href: '/docs' },
      {
        label: 'CLI · npm',
        desc: 'bun add -g lyra-ai-agent',
        href: 'https://www.npmjs.com/package/lyra-ai-agent',
        external: true,
      },
      {
        label: 'GitHub',
        desc: 'Source, releases & issues',
        href: 'https://github.com/rifkyeasy/lyra',
        external: true,
      },
    ],
  },
  // Research carries the verifiable-autonomy story.
  { label: 'Research', href: '/research' },
  { label: 'Pricing', href: '/pricing' },
  {
    label: 'More',
    items: [
      { label: 'About', desc: 'The mission behind Lyra', href: '/about' },
      { label: 'Solutions', desc: 'For individuals, teams & funds', href: '/solutions' },
      { label: 'Safety', desc: 'How the fund controls work', href: '/safety' },
      { label: 'Status', desc: 'Live system status', href: '/status' },
    ],
  },
]

const PILL_WIDTH = 1180
// Hero canvas wrap is `max-w-[1544px] sm:px-8`, so the painting content width
// caps at 1544 - 64 = 1480 (lovart parity). Logo/CTA at top of page anchor to
// the painting's left/right edges, computed from this constant + heroPad below.
const HERO_WRAP_MAX = 1544
const PILL_INSET = 8

const MORPH_TRAVEL_PX = 360
const MORPH_FALLBACK_END_PX = 520

// Scroll-tied nav morph. The pill is fixed-width at 1180px (matching the
// main content container width var(--container-wrap)) and centered. Logo
// and CTA sit at the pill's natural left/right edges. At the top of the
// page they translate further out to reach the hero canvas painting edges
// (1480px). As the user scrolls past the hero, both translations relax to
// 0 and the pill chrome (background + blur + border + shadow) fades into
// existence around them. End state: logo + CTA align with the content
// container below the navbar (Identity section, etc.).
//
// On phones (< md) the center nav links collapse into a hamburger overlay
// (Lovart pattern). The scroll-morph still runs but `computeSpread` returns
// 0 at narrow widths so logo + CTA sit at natural pill positions.
//
// Smoothing comes from two layers: Lenis interpolates raw scroll into smooth
// values, useSpring lerps any remaining delta before useTransform. Both run
// on compositor-friendly properties only (transform, opacity, filter, color
// via rgba alpha, shadow alpha) so the browser never reflows during scroll.
export function Navbar() {
  // Lenis (used by MotionProvider) intercepts wheel events and uses its own
  // rAF tick to advance window.scrollY. framer-motion's useScroll subscribes
  // to native scroll events, which never fire under Lenis (verified live May
  // 11 2026: scrollEventCount=0 even when window.scrollY=3600). So we drive
  // our scroll MotionValue directly from a rAF loop reading window.scrollY,
  // then feed useSpring + useTransform exactly as before , no other call
  // sites have to change.
  const scrollY = useMotionValue(0)
  const smoothScroll = useSpring(scrollY, { damping: 50, stiffness: 280, mass: 0.6 })

  const [morphEnd, setMorphEnd] = useState(MORPH_FALLBACK_END_PX)
  // CRITICAL: spread MUST initialize to 0 (the same value on server + client first
  // render) to avoid a React hydration mismatch. Reading window.innerWidth in
  // the useState initializer makes server (no window → 1920 fallback) and client
  // (real vw) produce different translateX values on the morph spans. The real
  // spread is measured in the useEffect below, after mount.
  const [spread, setSpread] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  // Which top-level dropdown is open on desktop (hover-driven). null = none.
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  // Mobile-only: track the bg color of whatever section is currently scrolled
  // behind the navbar, so the flat mobile nav strip seamlessly inherits the
  // section's color (Lovart pattern , cream over Hero/Sec3/Sec4, cream-deep
  // over Sec2, etc.) instead of staying one fixed shade.
  const [sectionBg, setSectionBg] = useState<string>('var(--color-cream)')

  useEffect(() => {
    if (typeof window === 'undefined') return
    const measure = () => {
      const hero = document.getElementById('hero')
      if (hero) {
        const heroBottom = hero.offsetTop + hero.offsetHeight
        setMorphEnd(Math.max(MORPH_FALLBACK_END_PX, heroBottom - 140))
      }
      setSpread(computeSpread(window.innerWidth))
    }
    measure()
    window.addEventListener('resize', measure)
    const t = window.setTimeout(measure, 600)
    return () => {
      window.removeEventListener('resize', measure)
      window.clearTimeout(t)
    }
  }, [])

  // Lock body scroll while menu is open, restore on close.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const original = document.body.style.overflow
    if (menuOpen) document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [menuOpen])

  // Esc closes the menu.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  // Scroll loop: push window.scrollY into the MotionValue driving the morph,
  // and run the section-bg probe so the mobile flat-bg matches whichever
  // section is currently behind the nav.
  //
  // Why setInterval and not useScroll: Lenis (in MotionProvider) intercepts
  // wheel events and updates window.scrollY through its own gsap.ticker rAF
  // loop. framer-motion's useScroll subscribes to native scroll events, which
  // never fire under Lenis (verified live May 11 2026: scrollEventCount stayed
  // 0 even at scrollY=3600). setInterval reliably fires in foreground tabs.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let lastY = -1
    const id = window.setInterval(() => {
      const y = window.scrollY
      if (y === lastY) return
      scrollY.set(y)
      lastY = y
      probeNavSectionBg(setSectionBg)
    }, 33)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const morphStart = Math.max(120, morphEnd - MORPH_TRAVEL_PX)

  // At top of page, logo translates LEFT by `spread`, CTA translates RIGHT.
  // Both relax to 0 (natural pill positions) as scroll progresses.
  const logoX = useTransform(smoothScroll, [morphStart, morphEnd], [-spread, 0])
  const ctaX = useTransform(smoothScroll, [morphStart, morphEnd], [spread, 0])
  const navY = useTransform(smoothScroll, [morphStart, morphEnd], [0, -2])

  // Glassy translucent end state , paper grain + content underneath show through.
  // Bg caps at 0.62 (not 1) so the pill never reads as a solid bar; blur
  // compensates so type behind it stays soft, not legible. Border + shadow
  // are dialed back to keep the pill feeling like a halo, not a card.
  const chromeOpacity = useTransform(smoothScroll, [morphStart, morphEnd], [0, 0.62])
  const chromeBlur = useTransform(smoothScroll, [morphStart, morphEnd], [0, 18])
  const chromeShadowAlpha = useTransform(smoothScroll, [morphStart, morphEnd], [0, 0.22])
  const chromeBorderAlpha = useTransform(smoothScroll, [morphStart, morphEnd], [0, 0.1])

  // Use the raw-rgb tokens declared in globals.css so the pill chrome
  // tracks the active theme (cream stays cream in light, deep-roast in
  // dark). framer-motion's useMotionTemplate emits the literal CSS each
  // frame, so the var() lookup happens at paint time.
  const chromeBg = useMotionTemplate`rgb(var(--rgb-cream) / ${chromeOpacity})`
  const chromeBorder = useMotionTemplate`1px solid rgb(var(--rgb-ink) / ${chromeBorderAlpha})`
  const chromeShadow = useMotionTemplate`0 18px 50px -28px rgb(var(--rgb-shadow) / ${chromeShadowAlpha})`
  const chromeFilter = useMotionTemplate`blur(${chromeBlur}px)`

  return (
    <>
      {/* Outer wrapper: flat bg at <md (Lovart mobile pattern) that inherits
          the color of whatever section currently sits behind the navbar. The
          color comes from the JS probe above, exposed as `--nav-section-bg`,
          and crossfades over 300ms when scrolling between sections so the
          strip never feels like a separate layer. At md+ the wrapper is
          transparent and the desktop pill chrome takes over. */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center bg-[var(--nav-section-bg,var(--color-cream))] pt-5 transition-colors duration-300 ease-out sm:pt-6 lg:bg-transparent"
        style={{ ['--nav-section-bg' as string]: sectionBg }}
      >
        <motion.nav
          className="pointer-events-auto relative flex h-[56px] w-full items-center"
          style={{
            y: navY,
            maxWidth: PILL_WIDTH,
            paddingLeft: PILL_INSET,
            paddingRight: PILL_INSET,
          }}
          aria-label="primary"
        >
          {/* Pill chrome , anchored to nav bounds, fades in via opacity + blur.
              Hidden on phones (Lovart pattern): mobile navbar is flat, not a pill. */}
          <motion.span
            aria-hidden
            className="absolute inset-0 -z-10 hidden rounded-full lg:block"
            style={{
              backgroundColor: chromeBg,
              backdropFilter: chromeFilter,
              WebkitBackdropFilter: chromeFilter,
              border: chromeBorder,
              boxShadow: chromeShadow,
            }}
          />

          {/* Logo , natural left of pill, translates further left at top of page.
              Wider left padding on phones (no pill chrome to seat against). */}
          <motion.div className="flex shrink-0 items-center pl-5 lg:pl-3" style={{ x: logoX }}>
            <Brand />
          </motion.div>

          {/* Middle items , desktop only (md+). Grouped entries open a dropdown
              panel on hover; flat entries are plain links. Phones get the
              hamburger overlay instead. */}
          <div
            className="hidden flex-1 items-center justify-center gap-6 lg:flex"
            onMouseLeave={() => setOpenMenu(null)}
          >
            {NAV.map(entry =>
              entry.items ? (
                <div
                  key={entry.label}
                  className="relative"
                  onMouseEnter={() => setOpenMenu(entry.label)}
                >
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[14px] font-medium tracking-[-0.005em] text-[var(--color-ink)] transition-colors duration-200 hover:text-[var(--color-ink-2)]"
                    aria-expanded={openMenu === entry.label}
                    aria-haspopup="menu"
                  >
                    {entry.label}
                    <Chevron open={openMenu === entry.label} />
                  </button>
                  <AnimatePresence>
                    {openMenu === entry.label ? (
                      <DropdownPanel
                        items={entry.items}
                        featured={entry.featured}
                        onNavigate={() => setOpenMenu(null)}
                      />
                    ) : null}
                  </AnimatePresence>
                </div>
              ) : (
                <NavLink key={entry.label} href={entry.href as string}>
                  {entry.label}
                </NavLink>
              ),
            )}
          </div>

          {/* CTA , natural right of pill, translates further right at top of page.
              On phones the CTA shrinks (compact variant) so it fits alongside
              the wordmark + hamburger without overlap. */}
          <motion.div
            className="ml-auto flex shrink-0 items-center gap-2 pr-4 md:ml-0 md:pr-1"
            style={{ x: ctaX }}
          >
            <PrimaryCta />
            <HamburgerButton open={menuOpen} onClick={() => setMenuOpen(v => !v)} />
          </motion.div>
        </motion.nav>
      </div>

      <AnimatePresence>
        {menuOpen ? <MobileMenuOverlay onClose={() => setMenuOpen(false)} /> : null}
      </AnimatePresence>
    </>
  )
}

// Distance the logo / CTA need to travel from their natural pill-edge
// positions out to the hero canvas painting edges so the navbar sits in
// the same vertical column as the hero content. Hero canvas wraps with
// `mx-auto max-w-[1480px] px-4 sm:px-8`, so the painting's left edge is
// `max(0, (vw - 1480) / 2) + heroPad`. Floors at 0 on viewports where
// the pill itself is already wider than the canvas content.
function computeSpread(vw: number) {
  const heroPad = vw < 640 ? 16 : 32
  const heroLeftEdge = Math.max(0, (vw - HERO_WRAP_MAX) / 2) + heroPad
  const navWidth = Math.min(vw, PILL_WIDTH)
  const pillLeftEdge = (vw - navWidth) / 2
  const logoNaturalX = pillLeftEdge + PILL_INSET
  return Math.max(0, logoNaturalX - heroLeftEdge)
}

// Sample the bg color of whatever section currently sits just under the navbar
// strip. Walks up from `elementFromPoint(vw/2, 96)` and adopts the bg of the
// first SECTION/MAIN/ARTICLE/BODY ancestor. The tag whitelist matters: without
// it, the probe will inherit the bg of any small UI island that happens to be
// vertically aligned with the center column (May 11 2026 incident: the dark
// `Run an agent →` CTA button below the hero headline made the mobile navbar
// turn solid black when scrolled into the probe line). Section-level containers
// span the full viewport, so adopting only their bg keeps the navbar tied to
// the page's compositional rhythm instead of whatever button it overlaps.
let __lastNavBg = ''
const SECTION_TAGS = new Set(['SECTION', 'MAIN', 'ARTICLE', 'BODY'])
function probeNavSectionBg(setSectionBg: (bg: string) => void) {
  if (typeof document === 'undefined') return
  const x = window.innerWidth / 2
  const y = 96
  let node: Element | null = document.elementFromPoint(x, y)
  if (!node) return
  while (node && node !== document.documentElement) {
    if (SECTION_TAGS.has(node.tagName)) {
      const bg = window.getComputedStyle(node).backgroundColor
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        if (bg !== __lastNavBg) {
          __lastNavBg = bg
          setSectionBg(bg)
        }
        return
      }
    }
    node = node.parentElement
  }
}

function Brand({ size = 'default' }: { size?: 'default' | 'large' }) {
  const cls =
    size === 'large'
      ? 'text-[28px] sm:text-[32px] tracking-[-0.02em]'
      : 'text-[24px] tracking-[-0.025em]'
  return (
    <Link
      href="/"
      className={`font-wordmark inline-flex shrink-0 items-center leading-none text-[var(--color-ink)] transition-opacity hover:opacity-75 ${cls}`}
      aria-label="lyra home"
    >
      lyra
    </Link>
  )
}

function PrimaryCta() {
  // Compact text at < md so the pill + hamburger + wordmark all fit on phone.
  return (
    <Link
      href="/console"
      className="group inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-[12.5px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_10px_24px_-14px_rgba(16,15,9,0.6)] transition-transform hover:-translate-y-[1px] active:translate-y-0 md:px-5 md:py-2.5 md:text-[13.5px]"
    >
      <span className="md:hidden">Console</span>
      <span className="hidden md:inline">Open console</span>
      <span
        aria-hidden
        className="hidden transition-transform group-hover:translate-x-0.5 md:inline"
      >
        →
      </span>
    </Link>
  )
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const isAnchor = href.startsWith('#')
  const className =
    'relative text-[14px] font-medium tracking-[-0.005em] text-[var(--color-ink)] transition-colors duration-200 hover:text-[var(--color-ink-2)]'
  if (isAnchor) {
    const id = href.slice(1)
    return (
      <a
        href={href}
        className={className}
        onClick={e => {
          const target = document.getElementById(id)
          if (!target) return
          const lenis = window.__lenis
          if (lenis) {
            e.preventDefault()
            lenis.scrollTo(target, {
              duration: 1.8,
              easing: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
            })
          }
        }}
      >
        {children}
      </a>
    )
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}

// ─────────── Desktop dropdown (hover mega-menu) ───────────

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
      className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
    >
      <path
        d="M2 3.5L5 6.5L8 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DropdownPanel({
  items,
  featured,
  onNavigate,
}: {
  items: NavChild[]
  featured?: NavChild
  onNavigate: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
      role="menu"
      // pt-3 is a transparent bridge so the cursor can travel from the trigger
      // to the panel without crossing a gap that would fire onMouseLeave.
      className="absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3"
    >
      <div className="w-[320px] rounded-2xl border border-[var(--color-border)] bg-[var(--color-paper)] p-2 shadow-[var(--shadow-card)]">
        {featured ? <FeaturedItem item={featured} onNavigate={onNavigate} /> : null}
        {items.map(it => (
          <DropdownItem key={it.label} item={it} onNavigate={onNavigate} />
        ))}
      </div>
    </motion.div>
  )
}

function FeaturedItem({ item, onNavigate }: { item: NavChild; onNavigate: () => void }) {
  const cls =
    'mb-1.5 block rounded-xl bg-[var(--color-ink)] px-3 py-3 transition-opacity hover:opacity-90'
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-medium text-[var(--color-cream)]">{item.label}</span>
        <span aria-hidden className="text-[var(--color-cream)]">
          →
        </span>
      </div>
      <div className="mt-0.5 text-[12.5px] text-[var(--color-cream)] opacity-70">{item.desc}</div>
    </>
  )
  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noreferrer"
        role="menuitem"
        className={cls}
        onClick={onNavigate}
      >
        {body}
      </a>
    )
  }
  return (
    <Link href={item.href} role="menuitem" className={cls} onClick={onNavigate}>
      {body}
    </Link>
  )
}

function DropdownItem({ item, onNavigate }: { item: NavChild; onNavigate: () => void }) {
  const cls = 'block rounded-xl px-3 py-2.5 transition-colors hover:bg-[var(--color-cream-deep)]'
  const body = (
    <>
      <div className="text-[14px] font-medium text-[var(--color-ink)]">{item.label}</div>
      <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-ink-3)]">{item.desc}</div>
    </>
  )
  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noreferrer"
        role="menuitem"
        className={cls}
        onClick={onNavigate}
      >
        {body}
      </a>
    )
  }
  if (item.href.startsWith('#')) {
    const id = item.href.slice(1)
    return (
      <a
        href={item.href}
        role="menuitem"
        className={cls}
        onClick={e => {
          onNavigate()
          const target = document.getElementById(id)
          if (!target) return
          const lenis = window.__lenis
          if (lenis) {
            e.preventDefault()
            lenis.scrollTo(target, {
              duration: 1.8,
              easing: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
            })
          }
        }}
      >
        {body}
      </a>
    )
  }
  return (
    <Link href={item.href} role="menuitem" className={cls} onClick={onNavigate}>
      {body}
    </Link>
  )
}

// ─────────── Hamburger button (visible < md) ───────────

function HamburgerButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? 'Close menu' : 'Open menu'}
      aria-expanded={open}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--color-ink)] transition-opacity hover:opacity-70 lg:hidden"
    >
      <span className="relative block h-[14px] w-5">
        <motion.span
          aria-hidden
          className="absolute left-0 right-0 top-0 h-[1.5px] origin-center rounded-full bg-current"
          animate={open ? { y: 6, rotate: 45 } : { y: 0, rotate: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
        />
        <motion.span
          aria-hidden
          className="absolute left-0 right-0 bottom-0 h-[1.5px] origin-center rounded-full bg-current"
          animate={open ? { y: -6, rotate: -45 } : { y: 0, rotate: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
        />
      </span>
    </button>
  )
}

// ─────────── Full-screen mobile menu overlay ───────────

function MobileMenuOverlay({ onClose }: { onClose: () => void }) {
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="primary menu"
      className="fixed inset-0 z-[60] flex flex-col bg-[var(--color-cream)] lg:hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
    >
      {/* Top bar , mirror the page navbar's exact coordinate system so the
          wordmark, CTA pill, and morphing hamburger/X stay at the same x
          positions when the menu opens (avoids a layout shift). */}
      <div className="flex justify-center pt-5 sm:pt-6">
        <div
          className="relative flex h-[56px] w-full items-center"
          style={{ maxWidth: PILL_WIDTH, paddingLeft: PILL_INSET, paddingRight: PILL_INSET }}
        >
          <div className="flex shrink-0 items-center pl-5 md:pl-3">
            <Brand />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 pr-4 md:ml-0 md:pr-1">
            <PrimaryCta />
            <HamburgerButton open onClick={onClose} />
          </div>
        </div>
      </div>

      {/* Nav items , grouped sections, scrollable for the fuller menu. */}
      <nav
        className="flex flex-1 flex-col gap-7 overflow-y-auto px-5 pt-6 pb-12 sm:px-8"
        aria-label="mobile primary"
      >
        {NAV.map((entry, gi) =>
          entry.items ? (
            <div key={entry.label}>
              <div className="font-mono mb-3 text-[11px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
                {entry.label}
              </div>
              <ul className="space-y-1">
                {entry.items.map((it, i) => (
                  <li key={it.label}>
                    <MobileSubLink
                      href={it.href}
                      external={it.external}
                      index={gi + i}
                      onClose={onClose}
                    >
                      {it.label}
                    </MobileSubLink>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <MenuLink key={entry.label} href={entry.href as string} index={gi} onClose={onClose}>
              {entry.label}
            </MenuLink>
          ),
        )}
      </nav>
    </motion.div>
  )
}

function MenuLink({
  href,
  index,
  children,
  onClose,
}: {
  href: string
  index: number
  children: React.ReactNode
  onClose: () => void
}) {
  const isAnchor = href.startsWith('#')
  const className =
    'font-display block text-[clamp(40px,11vw,64px)] font-light leading-[1.05] tracking-[-0.02em] text-[var(--color-ink)] transition-opacity hover:opacity-70'
  const initial = { y: 14, opacity: 0 }
  const animate = { y: 0, opacity: 1 }
  const transition = {
    delay: 0.08 + index * 0.06,
    duration: 0.45,
    ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
  }
  // Animate the wrapper, not the link itself — putting framer-motion on the
  // same element that carries Tailwind's `transition-opacity` causes the two
  // easings to fight over opacity per frame (visible jitter on the anchor
  // item where motion.a was applied directly).
  return (
    <motion.span initial={initial} animate={animate} transition={transition} className="block">
      {isAnchor ? (
        <a href={href} onClick={onClose} className={className}>
          {children}
        </a>
      ) : (
        <Link href={href} onClick={onClose} className={className}>
          {children}
        </Link>
      )}
    </motion.span>
  )
}

// Medium link used for the grouped sub-items in the mobile menu.
function MobileSubLink({
  href,
  external,
  index,
  children,
  onClose,
}: {
  href: string
  external?: boolean
  index: number
  children: React.ReactNode
  onClose: () => void
}) {
  const className =
    'block text-[22px] font-light leading-[1.35] tracking-[-0.01em] text-[var(--color-ink)] transition-opacity hover:opacity-70'
  const initial = { y: 10, opacity: 0 }
  const animate = { y: 0, opacity: 1 }
  const transition = {
    delay: 0.05 + index * 0.03,
    duration: 0.4,
    ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
  }
  return (
    <motion.span initial={initial} animate={animate} transition={transition} className="block">
      {external ? (
        <a href={href} target="_blank" rel="noreferrer" onClick={onClose} className={className}>
          {children}
        </a>
      ) : href.startsWith('#') ? (
        <a href={href} onClick={onClose} className={className}>
          {children}
        </a>
      ) : (
        <Link href={href} onClick={onClose} className={className}>
          {children}
        </Link>
      )}
    </motion.span>
  )
}
