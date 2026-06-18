'use client'

// "Integrated protocols" — a Morpho-style cosmic field. The Sui protocols Lyra's
// agent can execute within drift as nodes around a centered headline, over a
// starfield. Node positions ring the centre so the copy stays readable. Swap the
// initial badges for real protocol logos later by giving each entry a `logo`.
import { motion, useReducedMotion } from 'framer-motion'

type Tone = 'aqua' | 'violet' | 'plain'
type Node = { name: string; glyph: string; x: number; y: number; big?: boolean; tone?: Tone }

// Ringed around the centre (the 40–60 / 38–62 box is left clear for the headline).
const PROTOCOLS: Node[] = [
  { name: 'DeepBook', glyph: 'DB', x: 50, y: 15, big: true, tone: 'aqua' },
  { name: 'Walrus', glyph: 'W', x: 75, y: 21, big: true, tone: 'violet' },
  { name: 'Cetus', glyph: 'C', x: 25, y: 21 },
  { name: 'FlowX', glyph: 'Fx', x: 13, y: 41 },
  { name: 'Bluefin', glyph: 'B', x: 87, y: 39 },
  { name: 'Turbos', glyph: 'T', x: 19, y: 63 },
  { name: 'Scallop', glyph: 'S', x: 84, y: 61 },
  { name: 'NAVI', glyph: 'N', x: 30, y: 81 },
  { name: 'Suilend', glyph: 'SL', x: 71, y: 81 },
  { name: '7k Aggregator', glyph: '7k', x: 50, y: 87, tone: 'aqua' },
  { name: 'DefiLlama', glyph: 'DL', x: 12, y: 76 },
  { name: 'Pyth', glyph: 'Py', x: 88, y: 75 },
  { name: 'SuiNS', glyph: 'NS', x: 38, y: 11 },
  { name: 'Sui', glyph: 'Sui', x: 63, y: 89, tone: 'violet' },
]

// Deterministic starfield (index-derived → no hydration mismatch, no Math.random).
const STARS = Array.from({ length: 70 }, (_, i) => ({
  x: (i * 47.3) % 100,
  y: (i * 71.9) % 100,
  o: 0.12 + ((i * 17) % 45) / 100,
  s: 1 + (i % 3) * 0.6,
}))

const TONES: Record<Tone, string> = {
  aqua: 'border-[var(--color-accent)]/40 bg-[rgba(43,143,255,0.14)] text-white shadow-[0_0_28px_rgba(43,143,255,0.35)]',
  violet: 'border-[#7c6bff]/45 bg-[rgba(124,107,255,0.14)] text-white shadow-[0_0_28px_rgba(124,107,255,0.35)]',
  plain: 'border-white/15 bg-white/[0.05] text-white/90 shadow-[0_0_22px_rgba(255,255,255,0.06)]',
}

export function IntegratedProtocols() {
  const reduce = useReducedMotion()

  return (
    <section id="protocols" className="relative isolate overflow-hidden bg-[#070810] py-[clamp(120px,18vh,220px)]">
      {/* starfield */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {STARS.map((s, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white"
            style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.s, height: s.s, opacity: s.o }}
          />
        ))}
        {/* centre glow */}
        <div className="absolute left-1/2 top-1/2 h-[460px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(43,143,255,0.12),transparent_70%)]" />
      </div>

      {/* drifting protocol nodes */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {PROTOCOLS.map((p, i) => {
          const tone = TONES[p.tone ?? 'plain']
          const dim = p.big ? 'h-12 w-12 text-[15px]' : 'h-10 w-10 text-[13px]'
          return (
            <motion.div
              key={p.name}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5"
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              animate={reduce ? undefined : { y: [0, i % 2 ? -11 : 11, 0] }}
              transition={{ duration: 6 + (i % 5), repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut', delay: i * 0.35 }}
            >
              <span
                className={`flex items-center justify-center rounded-full border font-display backdrop-blur-sm ${dim} ${tone}`}
              >
                {p.glyph}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] tracking-wide text-white/45">{p.name}</span>
            </motion.div>
          )
        })}
      </div>

      {/* centered headline */}
      <div className="relative z-10 mx-auto max-w-[var(--container-wrap)] px-6 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--color-accent)]">
          Integrated protocols
        </p>
        <h2 className="mx-auto mt-3 max-w-[14ch] font-display text-[clamp(30px,4.2vw,54px)] leading-[1.05] text-white">
          Bounded to the Sui DeFi you approve
        </h2>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-white/55">
          Your agent executes only within the protocol scope set by your on-chain policy — swaps,
          order-book liquidity, lending, oracles, and durable Walrus storage.
        </p>
      </div>
    </section>
  )
}
