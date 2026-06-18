'use client'

import { motion } from 'framer-motion'
import { LayerHeader } from './V2Identity'

export function V3Brain() {
  return (
    <section
      id="layer-brain"
      className="relative flex min-h-screen items-center py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <LayerHeader idx="02" title="Simulate" pill="Gate 02 · dry-run" />
        <div className="grid items-center gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7 lg:order-1">
            <EnclaveCard />
          </div>
          <div className="space-y-6 lg:col-span-5 lg:order-2">
            <motion.h2
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
              className="font-display text-[clamp(36px,5vw,68px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)]"
            >
              Doomed transactions <span className="font-italic-serif italic">never</span> reach gas.
            </motion.h2>
            <p className="max-w-md text-[15px] leading-relaxed text-[var(--color-ink-2)]">
              Once policy passes, the PTB is dry-run against a live Sui fullnode before a single unit
              of gas is spent. A failing effect aborts the action with a decoded reason, so the agent
              finds out it would fail without ever paying for it.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function EnclaveCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.95, ease: [0.22, 1, 0.36, 1] }}
      className="relative mx-auto max-w-[520px]"
    >
      <div
        className="relative rounded-[12px] bg-[var(--color-cream-warm)] p-7"
        style={{
          boxShadow: 'var(--shadow-doc-asym)',
          clipPath:
            'polygon(14px 0, calc(100% - 14px) 0, 100% 14px, 100% calc(100% - 14px), calc(100% - 14px) 100%, 14px 100%, 0 calc(100% - 14px), 0 14px)',
        }}
      >
        <div className="font-mono mb-2 flex items-center justify-between text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          <span>SIMULATION · PRE-FLIGHT</span>
          <Checkmark />
        </div>
        <div className="font-display text-[24px] leading-tight text-[var(--color-ink)]">
          swap.execute
        </div>
        <div className="font-mono mt-1 text-[12px] text-[var(--color-ink-2)]">
          1 SUI → USDC · Cetus · 0.05% tier
        </div>

        <div className="mt-5 space-y-2 border-y border-[var(--color-border)] py-4 text-[12px]">
          <Row label="method" value="dryRunTransactionBlock" />
          <Row label="est. gas" value="142,308" />
          <Row label="result" value="would succeed" />
          <Row label="min out" value="0.998 USDC" />
        </div>

        <div className="font-mono mt-4 flex items-baseline justify-between text-[11.5px] text-[var(--color-ink-3)]">
          <span className="uppercase tracking-[0.18em]">verdict</span>
          <span>
            <span className="text-[var(--color-ink)]">cleared</span> ·
            slippage <span className="text-[var(--color-ink)]">18</span> bps
          </span>
        </div>
      </div>

      <p className="mt-5 text-center text-[13px] text-[var(--color-ink-2)]">
        a revert here aborts before any gas is spent. An illustrative pre-flight, not a live trade.
      </p>
    </motion.div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono flex items-baseline justify-between gap-3 text-[11.5px]">
      <span className="text-[var(--color-ink-3)] uppercase tracking-[0.16em]">{label}</span>
      <span className="text-[var(--color-ink)]">{value}</span>
    </div>
  )
}

function Checkmark() {
  return (
    <motion.svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ delay: 0.6 }}
    >
      <motion.path
        d="M3 8.5 L7 12 L13 4"
        stroke="var(--color-ink)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.7, delay: 0.7, ease: [0.22, 1, 0.36, 1] }}
      />
    </motion.svg>
  )
}
