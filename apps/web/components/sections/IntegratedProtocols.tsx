'use client'

// "Integrated across Sui DeFi" — a scroll-driven cosmic section over the 5.avif
// portal. The protocol logos (real, self-hosted from DefiLlama) are laid out on a
// semicircle that follows the image's arc; scroll progress zooms them in from
// fully invisible. The bottom of the image is masked so it doesn't look hard-cut.
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'

type Node = { name: string; logo: string; big?: boolean }

// Ordered left → right along the arc; the big marks land near the top-centre peak.
const PROTOCOLS: Node[] = [
  { name: 'Sui', logo: '/protocols/sui.jpg', big: true },
  { name: 'Pyth', logo: '/protocols/pyth.jpg' },
  { name: 'Cetus', logo: '/protocols/cetus.png' },
  { name: 'FlowX', logo: '/protocols/flowx.png' },
  { name: 'Turbos', logo: '/protocols/turbos.png' },
  { name: 'DeepBook', logo: '/protocols/deepbook.jpg', big: true },
  { name: 'Walrus', logo: '/protocols/walrus.png', big: true },
  { name: 'Bluefin', logo: '/protocols/bluefin.png' },
  { name: 'Scallop', logo: '/protocols/scallop.jpg' },
  { name: 'NAVI', logo: '/protocols/navi.jpg' },
  { name: 'Suilend', logo: '/protocols/suilend.png' },
  { name: 'Volo', logo: '/protocols/volo.webp' },
  { name: '7k Aggregator', logo: '/protocols/sevenk.jpg' },
]

// Semicircle (in %) that traces the portal arc. On phones the arc is steeper
// (bigger ry) and a touch wider (bigger rx) so 13 nodes get more vertical +
// horizontal separation instead of crowding into an overlapping cluster.
const ARC_DESKTOP = { cx: 50, cy: 80, rx: 40, ry: 48 }
const ARC_MOBILE = { cx: 50, cy: 82, rx: 44, ry: 62 }
const A_LEFT = (170 * Math.PI) / 180
const A_RIGHT = (10 * Math.PI) / 180
function arcPos(i: number, n: number, arc: typeof ARC_DESKTOP) {
  const t = n <= 1 ? 0.5 : i / (n - 1)
  const theta = A_LEFT + (A_RIGHT - A_LEFT) * t
  return { x: arc.cx + arc.rx * Math.cos(theta), y: arc.cy - arc.ry * Math.sin(theta) }
}

// Deterministic faint starfield (index-derived → no hydration mismatch).
const STARS = Array.from({ length: 64 }, (_, i) => ({
  x: (i * 47.3) % 100,
  y: (i * 71.9) % 100,
  o: 0.1 + ((i * 17) % 40) / 100,
  s: 1 + (i % 3) * 0.5,
}))

export function IntegratedProtocols() {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })

  // Narrow-viewport arc, measured after mount (starts desktop to match SSR, so
  // no hydration mismatch; the field is invisible until scrolled in, so the
  // one-frame correction never flashes).
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const m = () => setNarrow(window.innerWidth < 640)
    m()
    window.addEventListener('resize', m)
    return () => window.removeEventListener('resize', m)
  }, [])
  const arc = narrow ? ARC_MOBILE : ARC_DESKTOP

  // Staged scroll sequence so the layers enter/leave in order:
  //   IN  → the portal image fades up first (0 → 0.12), THEN the logos + title
  //          zoom/fade in (0.16 → 0.34).
  //   OUT → the logos + title leave first (0.74 → 0.86), THEN the image fades
  //          back to 0 last (0.88 → 1).
  // Each layer's window is nested inside the one before it, so you never see a
  // logo without its backdrop, nor the backdrop vanish while logos still show.
  const imageOpacity = useTransform(scrollYProgress, [0, 0.12, 0.88, 1], [0, 1, 1, 0])
  const fieldScale = useTransform(scrollYProgress, [0.16, 0.62], [0.5, 1])
  const fieldOpacity = useTransform(scrollYProgress, [0.16, 0.34, 0.74, 0.86], [0, 1, 1, 0])
  const starScale = useTransform(scrollYProgress, [0, 1], [1.12, 1.4])
  const headOpacity = useTransform(scrollYProgress, [0.34, 0.5, 0.72, 0.84], [0, 1, 1, 0])
  const headY = useTransform(scrollYProgress, [0.34, 0.5], [26, 0])

  return (
    <section ref={ref} id="protocols" className="relative h-[260vh] bg-black">
      <div className="isolate sticky top-0 flex h-screen items-center justify-center overflow-hidden">
        {/* space background (5.avif) — glowing portal, bottom masked into the section */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {/* The portal image itself fades in first / out last on scroll (over the
              section's own bg-black), while the cream edge-fades stay static so the
              section always blends into the cream sections above + below. */}
          <motion.div
            className="absolute inset-0"
            style={reduce ? undefined : { opacity: imageOpacity }}
          >
            <Image
              src="/space/5.avif"
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover object-bottom"
            />
            <div className="absolute inset-0 bg-black/20" />
          </motion.div>
          {/* edges fade into the site background (cream) so the dark section blends
              into the cream sections above and below — not a hard black cut. */}
          <div className="absolute inset-x-0 bottom-0 h-[28%] bg-gradient-to-t from-[var(--color-cream)] via-[var(--color-cream)]/80 to-transparent" />
          <div className="absolute inset-x-0 top-0 h-[16%] bg-gradient-to-b from-[var(--color-cream)] to-transparent" />
        </div>

        {/* faint starfield (slow parallax) */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={reduce ? undefined : { scale: starScale }}
        >
          {STARS.map((s, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static decorative field
              key={i}
              className="absolute rounded-full bg-white"
              style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.s, height: s.s, opacity: s.o }}
            />
          ))}
        </motion.div>

        {/* protocol logos on a semicircle — the whole field zooms in on scroll */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={reduce ? undefined : { scale: fieldScale, opacity: fieldOpacity }}
        >
          {PROTOCOLS.map((p, i) => {
            const { x, y } = arcPos(i, PROTOCOLS.length, arc)
            // Smaller marks + labels on phones so 13 nodes don't overlap.
            const dim = p.big ? 'h-10 w-10 sm:h-14 sm:w-14' : 'h-8 w-8 sm:h-11 sm:w-11'
            return (
              <motion.div
                key={p.name}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 sm:gap-2"
                style={{ left: `${x}%`, top: `${y}%` }}
                animate={reduce ? undefined : { y: [0, i % 2 ? -7 : 7, 0] }}
                transition={{
                  duration: 6 + (i % 5),
                  repeat: Number.POSITIVE_INFINITY,
                  ease: 'easeInOut',
                  delay: i * 0.3,
                }}
              >
                <span
                  className={`overflow-hidden rounded-full bg-white shadow-[0_8px_30px_-6px_rgba(0,0,0,0.6)] ring-1 ring-white/15 ${dim}`}
                >
                  <Image src={p.logo} alt={p.name} width={56} height={56} className="h-full w-full object-cover" />
                </span>
                <span className="max-w-[4.5rem] text-center font-mono text-[8px] leading-tight tracking-wide text-white/55 sm:max-w-none sm:whitespace-nowrap sm:text-[10px]">
                  {p.name}
                </span>
              </motion.div>
            )
          })}
        </motion.div>

        {/* centered title only */}
        <motion.h2
          className="relative z-10 mx-auto max-w-[15ch] px-6 text-center font-display text-[clamp(32px,4.6vw,60px)] leading-[1.04] text-white"
          style={reduce ? undefined : { opacity: headOpacity, y: headY }}
        >
          Integrated across Sui DeFi
        </motion.h2>
      </div>
    </section>
  )
}
