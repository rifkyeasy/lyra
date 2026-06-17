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
    // Light-scheme favicons are the default. Color-scheme-aware overrides
    // for dark mode are injected as explicit <link media> tags in <head>
    // below, since Next's metadata.icons does not support media queries.
    icon: [
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
    images: [
      {
        url: '/og-image.jpg',
        width: 1200,
        height: 800,
        type: 'image/jpeg',
        alt: 'Lyra — a policy-aware AI treasury agent on Sui',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@lyraai_space',
    creator: '@lyraai_space',
    title: 'Lyra AI — verifiable autonomy for on-chain treasuries on Sui',
    description:
      'The AI advises. Deterministic code enforces the fund controls. Real on-chain work on Sui, gated by policy, simulation, and approval.',
    images: ['/og-image.jpg'],
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
          Color-scheme-aware favicons. Next's metadata.icons cannot express
          media queries, so the dark-scheme overrides live here as explicit
          <link media> tags. Light is the default (also set via metadata.icons);
          browsers honoring prefers-color-scheme pick the dark set when active.
        */}
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/icons/light/favicon-32x32.png"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/icons/light/favicon-16x16.png"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/icons/dark/favicon-32x32.png"
          media="(prefers-color-scheme: dark)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/icons/dark/favicon-16x16.png"
          media="(prefers-color-scheme: dark)"
        />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/icons/light/apple-touch-icon.png"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/icons/dark/apple-touch-icon.png"
          media="(prefers-color-scheme: dark)"
        />
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
