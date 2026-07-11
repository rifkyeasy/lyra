import { ChunkReload } from '@/components/ChunkReload'
import { MotionProvider } from '@/components/MotionProvider'
import { PaperNoise } from '@/components/PaperNoise'
import { THEME_STORAGE_KEY } from '@/components/theme/constants'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import { ThemeScript } from '@/components/theme/ThemeScript'
import type { Metadata, Viewport } from 'next'
import { Fraunces, Geist_Mono, Instrument_Serif, Outfit } from 'next/font/google'
import { cookies } from 'next/headers'
import localFont from 'next/font/local'
import { GoogleAnalytics } from '@next/third-parties/google'
import { Providers } from './providers'
import './globals.css'

const fraunces = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-fraunces',
})

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['italic', 'normal'],
  display: 'swap',
  variable: '--font-instrument-serif',
})

const outfit = Outfit({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-outfit',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist-mono',
})

const calSans = localFont({
  src: '../public/fonts/CalSans-Regular.woff2',
  weight: '400',
  display: 'swap',
  variable: '--font-cal-sans',
})

// Basik W05 Book — Lyra's display typeface (a clean geometric sans, replacing
// Nebula's Fraunces serif for a distinct, modern identity).
const basik = localFont({
  src: '../public/fonts/Basik-Book.woff2',
  weight: '400',
  display: 'swap',
  variable: '--font-basik',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://lyraai.space'),
  title: 'Lyra AI',
  description:
    'The AI advises. Deterministic code enforces the fund controls. Lyra does real on-chain work on Sui from the terminal, Telegram, or a web console, with every value-moving action gated by policy, simulation, and approval.',
  applicationName: 'lyra',
  manifest: '/site.webmanifest',
  robots: { index: true, follow: true },
  category: 'technology',
  creator: 'lyra',
  publisher: 'lyra',
  icons: {
    // The theme-adaptive SVG comes FIRST — Chrome/Edge/Firefox prefer it and
    // re-color the mark live with the browser's light/dark theme (see favicon.svg).
    // The PNGs are the Safari fallback (no SVG-favicon support there).
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/light/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/light/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    // iOS fills icon transparency with black, so use the cream mark (visible) at
    // the conventional root path rather than the dark mark.
    apple: '/apple-touch-icon.png',
  },
  authors: [{ name: 'lyra', url: 'https://x.com/lyraai_space' }],
  keywords: [
    'lyra',
    'Sui',
    'AI treasury assistant',
    'AI agent',
    'DeFi agent',
    'policy engine',
    'transaction simulation',
    'on-chain agent',
    'Cetus',
    'NAVI',
    'DeepBook',
    'Walrus',
  ],
  openGraph: {
    type: 'website',
    url: 'https://lyraai.space',
    siteName: 'lyra',
    locale: 'en_US',
    title: 'Lyra AI — verifiable autonomy for on-chain treasuries on Sui',
    description:
      'The AI advises. Deterministic code enforces the fund controls. Real on-chain work on Sui, gated by policy, simulation, and approval.',
    // og:image comes from app/opengraph-image.tsx (code-generated).
  },
  twitter: {
    card: 'summary_large_image',
    site: '@lyraai_space',
    creator: '@lyraai_space',
    title: 'Lyra AI — verifiable autonomy for on-chain treasuries on Sui',
    description:
      'The AI advises. Deterministic code enforces the fund controls. Real on-chain work on Sui, gated by policy, simulation, and approval.',
    // twitter:image inherits the generated app/opengraph-image.tsx.
  },
  alternates: {
    canonical: '/',
    types: {
      'text/plain': [
        { url: '/llms.txt', title: 'llms.txt' },
        { url: '/llms-full.txt', title: 'llms-full.txt' },
      ],
    },
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f9f8f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0d0a' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read theme cookie server-side so the first byte of HTML carries the
  // right <html class>. Without this, dark-OS users with an explicit
  // light pick see a flash of dark: the @media (prefers-color-scheme: dark)
  // rule applies because no .light class is on <html> yet, the inline
  // script later adds the class but several paints (and the browser's
  // navigation theme-color background) have already rendered dark.
  // The cookie is mirrored from localStorage by ThemeProvider on mount.
  const cookieStore = await cookies()
  const cookieTheme = cookieStore.get(THEME_STORAGE_KEY)?.value
  const themeClass = cookieTheme === 'dark' || cookieTheme === 'light' ? cookieTheme : ''

  return (
    <html
      lang="en"
      className={`${themeClass} ${basik.variable} ${fraunces.variable} ${instrumentSerif.variable} ${outfit.variable} ${geistMono.variable} ${calSans.variable}`}
      data-theme-ssr={cookieTheme || 'unset'}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
        {/*
          Theme-adaptive favicon: a single SVG (declared in metadata.icons) whose
          mark re-colors for light/dark via an embedded @media (prefers-color-scheme)
          — Chrome/Edge/Firefox honor it and swap it live with the browser theme,
          so the mark is never a dark logo on a dark tab. Safari (no SVG favicon
          support) falls back to the PNG/ico in metadata.icons.
        */}
      </head>
      <body>
        <ThemeProvider>
          <Providers>
            <MotionProvider>
              <ChunkReload />
              <PaperNoise />
              {children}
            </MotionProvider>
          </Providers>
        </ThemeProvider>
        <GoogleAnalytics gaId="G-2GKESFPTBT" />
      </body>
    </html>
  )
}
