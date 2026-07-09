'use client'

// "Integrated across Sui DeFi" — a scroll-driven cosmic section over the 5.avif
// portal. The protocol logos (real, self-hosted from DefiLlama) are laid out on a
// semicircle that follows the image's arc; scroll progress zooms them in from
// fully invisible. The bottom of the image is masked so it doesn't look hard-cut.
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import Image from 'next/image'
import { useRef } from 'react'

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

// Semicircle (in %) that traces the portal arc. Tune cx/cy/rx/ry to match.
const ARC = { cx: 50, cy: 80, rx: 40, ry: 48 }
const A_LEFT = (170 * Math.PI) / 180
const A_RIGHT = (10 * Math.PI) / 180
function arcPos(i: number, n: number) {
  const t = n <= 1 ? 0.5 : i / (n - 1)
  const theta = A_LEFT + (A_RIGHT - A_LEFT) * t
  return { x: ARC.cx + ARC.rx * Math.cos(theta), y: ARC.cy - ARC.ry * Math.sin(theta) }
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

  // Scroll → zoom: the constellation grows from a distant cluster to full spread,
  // emerging from fully invisible, while the starfield drifts (parallax).
  const fieldScale = useTransform(scrollYProgress, [0, 0.62], [0.4, 1])
  const fieldOpacity = useTransform(scrollYProgress, [0, 0.06, 0.28, 0.92, 1], [0, 0, 1, 1, 0.85])
  const starScale = useTransform(scrollYProgress, [0, 1], [1.12, 1.4])
  const headOpacity = useTransform(scrollYProgress, [0.28, 0.52], [0, 1])
  const headY = useTransform(scrollYProgress, [0.28, 0.52], [26, 0])

  return (
    <section ref={ref} id="protocols" className="relative h-[260vh] bg-black">
      <div className="isolate sticky top-0 flex h-screen items-center justify-center overflow-hidden">
        {/* space background (5.avif) — glowing portal, bottom masked into the section */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <Image src="/space/5.avif" alt="" fill priority sizes="100vw" className="object-cover object-bottom" />
          <div className="absolute inset-0 bg-black/20" />
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
            const { x, y } = arcPos(i, PROTOCOLS.length)
            const dim = p.big ? 'h-14 w-14' : 'h-11 w-11'
            return (
              <motion.div
                key={p.name}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
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
                <span className="whitespace-nowrap font-mono text-[10px] tracking-wide text-white/55">{p.name}</span>
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
