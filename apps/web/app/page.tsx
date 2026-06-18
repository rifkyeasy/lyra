import { Navbar } from '@/components/Navbar'
import { Footer } from '@/components/Footer'
import { Hero } from '@/components/sections/Hero'
import { IntegratedProtocols } from '@/components/sections/IntegratedProtocols'
import { V1Opener } from '@/components/sections/section2/V1Opener'

export const metadata = {
  title: 'Lyra AI',
  description:
    'An AI agent that does real on-chain work on Sui. The AI advises; deterministic code enforces the fund controls. Every value-moving action runs through policy, simulation, and approval before it broadcasts.',
}

export default function LandingPage() {
  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <Navbar />
      <Hero />
      <V1Opener />
      <IntegratedProtocols />
      <Footer />
    </main>
  )
}
