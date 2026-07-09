'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { CYCLES } from '@/lib/cycles'
import { TuiCanvas } from './hero/TuiCanvas'
import { TgCanvas } from './hero/TgCanvas'
import { OutputCanvas } from './hero/OutputCanvas'

export function HeroCanvas() {
  const [activeIdx, setActiveIdx] = useState(0)
  const cycle = CYCLES[activeIdx]!

  useEffect(() => {
    const id = setTimeout(() => {
      setActiveIdx(i => (i + 1) % CYCLES.length)
    }, cycle.durationMs)
    return () => clearTimeout(id)
  }, [activeIdx, cycle.durationMs])

  return (
    <div className="relative">
      {/* OUTER canvas , Aurelia painting IS the background. No blur, near-full
          opacity, brushstrokes visible. The painting is the artwork, not a wash.
          Locked to 16:9 from sm: upward to match lovart's hero canvas proportion
          (1480 × 833 at desktop). On phones we use an explicit clamped height so
          long replies (cycle 3 audit report) overflow INSIDE the chat scrollback
          instead of pushing the canvas + page taller. */}
      <div className="relative isolate h-[clamp(540px,78svh,720px)] overflow-hidden rounded-[24px] border border-[var(--color-border)] shadow-[0_40px_80px_-50px_rgba(40,28,18,0.5)] sm:h-auto sm:aspect-[16/9] sm:min-h-[460px]">
        {CYCLES.map((c, i) => (
          <Image
            key={c.id}
            src={`/space/${c.painting}.avif`}
            alt=""
            fill
            priority={i === 0}
            loading={i === 0 ? undefined : 'lazy'}
            quality={85}
            sizes="(min-width: 1024px) 1480px, 100vw"
            className="object-cover transition-opacity duration-[1200ms] ease-out"
            style={{
              opacity: i === activeIdx ? 0.95 : 0,
              transform: 'scale(1.04)',
            }}
          />
        ))}

        {/* Subtle outer vignette so the inner frame's shadow has somewhere to sit
            and the painting feels framed instead of bleeding to nothing at edges. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(110% 80% at 50% 50%, rgba(20,15,8,0) 55%, rgba(20,15,8,0.10) 100%)',
          }}
        />

        {/* Painting margin , top + sides only. Lovart-coded: the inner frame
            extends FLUSH to the bottom edge of the painting (no pb), so the
            painting reads as a frame on three sides with the content butting
            up against the bottom. `flex h-full flex-col` always-on so the
            chat scrollback can overflow internally on phones. */}
        <div className="relative flex h-full flex-col px-5 pt-5 sm:px-10 sm:pt-10 lg:px-12 lg:pt-12">
          {/* INNER content frame , clean surface that holds the actual app UI.
              Bottom radius is 0 so the frame seats flush against the painting's
              rounded bottom; outer's overflow-hidden masks any bleed. */}
          <div className="relative flex flex-1 overflow-hidden rounded-t-[14px] border border-b-0 border-[var(--color-border)] bg-[var(--color-paper)] shadow-[0_-24px_50px_-30px_rgba(40,28,18,0.32)]">
            <div className="grid h-full min-h-0 w-full grid-cols-12 grid-rows-1 gap-0">
              {/* Chat surface , full width until lg (voyage hidden), 5/12 from lg: up.
                  The voyage panel's dense two-column narration overflows its column
                  at tablet widths, so we keep it desktop-only and show chat-only
                  below — the page reads cleanly without a cramped, clipped panel. */}
              <div className="col-span-12 lg:col-span-5 lg:border-r lg:border-[var(--color-border)]">
                {cycle.surface === 'tui' ? (
                  <TuiCanvas key={cycle.id} cycle={cycle} />
                ) : (
                  <TgCanvas key={cycle.id} cycle={cycle} />
                )}
              </div>

              {/* Output canvas (voyage) , desktop-only (lg+), 7/12. */}
              <div className="hidden lg:col-span-7 lg:block">
                <OutputCanvas key={`${cycle.id}-out`} cycle={cycle} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
