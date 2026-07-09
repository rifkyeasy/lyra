import { ImageResponse } from 'next/og'

// Code-generated share card (replaces the old static Nebula image). Next serves
// this for both og:image and twitter:image once the explicit metadata images are
// dropped from layout.tsx. Statically rendered at build time.
export const alt = 'Lyra — an autonomous, policy-bound AI finance agent on Sui'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: '#0b0e15',
        padding: '80px',
        justifyContent: 'space-between',
        position: 'relative',
        fontFamily: 'sans-serif',
      }}
    >
      {/* accent glow (aqua → violet), top-right */}
      <div
        style={{
          position: 'absolute',
          top: -220,
          right: -180,
          width: 760,
          height: 760,
          borderRadius: 760,
          display: 'flex',
          background:
            'radial-gradient(circle, rgba(43,143,255,0.40) 0%, rgba(124,107,255,0.16) 45%, rgba(11,14,21,0) 70%)',
        }}
      />

      <div style={{ display: 'flex', fontSize: 40, color: '#868d99', letterSpacing: 1 }}>
        lyraai.space
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            fontSize: 168,
            fontWeight: 800,
            color: '#f5f7fa',
            letterSpacing: -8,
            lineHeight: 1,
            marginBottom: 28,
          }}
        >
          lyra
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 58,
            fontWeight: 600,
            color: '#e9edf4',
            lineHeight: 1.15,
            maxWidth: 960,
            marginBottom: 20,
          }}
        >
          Do anything on-chain, across Sui.
        </div>
        <div style={{ display: 'flex', fontSize: 34, color: '#a2a7b2', maxWidth: 960, lineHeight: 1.3 }}>
          An AI agent that acts only inside rules you set. It proposes — Sui enforces.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <div
          style={{
            display: 'flex',
            width: 18,
            height: 18,
            borderRadius: 9,
            background: '#2b8fff',
          }}
        />
        <div style={{ display: 'flex', fontSize: 30, color: '#868d99' }}>
          Autonomous finance agent · live on Sui mainnet
        </div>
      </div>
    </div>,
    { ...size },
  )
}
