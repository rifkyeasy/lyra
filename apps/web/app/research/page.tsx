import { Footer } from '@/components/Footer'
import { SubNavbar } from '@/components/SubNavbar'
import Link from 'next/link'

export const metadata = {
  title: 'Research & writing · lyra',
  description:
    'How lyra thinks about verifiable autonomy — notes on the four-gate write pipeline, keeping AI advisory, Sui-address identity, and policy as code.',
}

type Entry = { tag: string; title: string; blurb: string; href: string; external?: boolean }

const FEATURED: Entry = {
  tag: 'Thesis',
  title: 'Verifiable autonomy: the AI advises, code enforces',
  blurb:
    'The core idea behind lyra — why an autonomous agent should never hold keys, and how four deterministic gates make “wrong model” a non-event for your funds.',
  href: '/research/verifiable-autonomy',
}

const ENTRIES: Entry[] = [
  {
    tag: 'Architecture',
    title: 'The four-gate write pipeline',
    blurb: 'Policy → simulate (dry-run) → approve → execute. How every PTB is checked before it broadcasts on Sui and returns a tx digest.',
    href: '/research/four-gate-pipeline',
  },
  {
    tag: 'Identity',
    title: 'A Sui address is the agent identity',
    blurb: 'Each agent is a Sui keypair; its on-chain history of policy-checked PTBs and Walrus receipts lets its track record be checked, not just claimed.',
    href: '/research/sui-address-identity',
  },
  {
    tag: 'Policy',
    title: 'Policy as code, not prompts',
    blurb: 'Why fund controls live in deterministic code and the on-chain lyra::policy Move package — allowlists, caps, slippage and health-factor floors.',
    href: '/research/policy-as-code',
  },
  {
    tag: 'Runtime',
    title: 'The agent’s brain & memory',
    blurb: 'The OpenAI-compatible brain, local file-based memory, and how context is assembled per turn.',
    href: '/research/brain-and-memory',
  },
  {
    tag: 'Runtime',
    title: 'Tools & plugins',
    blurb: 'The tool registry and plugin host that give the agent real capabilities — read, swap, lend, transfer.',
    href: '/research/tools-and-plugins',
  },
  {
    tag: 'Source',
    title: 'Read the source',
    blurb: 'lyra is open source. Browse the policy spine, the lyra::policy Move package, and the plugin host on GitHub.',
    href: 'https://github.com/rifkyeasy/lyra',
    external: true,
  },
]

export default function ResearchPage() {
  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <SubNavbar label="research" />
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 pb-24 pt-28 sm:px-8 md:pt-32">
        <header className="flex max-w-[64ch] flex-col gap-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-ink-3)]">
            Research &amp; writing
          </span>
          <h1
            className="font-display text-[clamp(38px,5vw,68px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
          >
            How lyra thinks about verifiable autonomy.
          </h1>
          <p className="text-[16px] leading-relaxed text-[var(--color-ink-2)]">
            Notes and deep-dives on the ideas behind the product — the safety model, on-chain identity,
            and the engineering that makes an AI agent safe with money.
          </p>
        </header>

        {/* Featured */}
        <ResearchCard entry={FEATURED} featured />

        {/* Grid */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENTRIES.map(e => (
            <ResearchCard key={e.title} entry={e} />
          ))}
        </div>
      </div>
      <Footer />
    </main>
  )
}

function ResearchCard({ entry, featured }: { entry: Entry; featured?: boolean }) {
  const className = `group flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-paper)] p-6 transition-colors hover:border-[var(--color-ink-3)] ${
    featured ? 'mt-8' : ''
  }`
  const inner = (
    <>
      <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
        {entry.tag}
      </span>
      <h2
        className={`mt-3 font-display font-light leading-[1.12] tracking-tight text-[var(--color-ink)] ${
          featured ? 'text-[clamp(24px,3vw,34px)]' : 'text-[20px]'
        }`}
        style={{ fontVariationSettings: '"opsz" 72' }}
      >
        {entry.title}
      </h2>
      <p
        className={`mt-2 leading-relaxed text-[var(--color-ink-2)] ${featured ? 'max-w-[60ch] text-[15px]' : 'text-[13.5px]'}`}
      >
        {entry.blurb}
      </p>
      <span className="mt-5 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-ink)]">
        Read
        <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
          {entry.external ? ' ↗' : ' →'}
        </span>
      </span>
    </>
  )
  if (entry.external) {
    return (
      <a href={entry.href} target="_blank" rel="noreferrer" className={className}>
        {inner}
      </a>
    )
  }
  return (
    <Link href={entry.href} className={className}>
      {inner}
    </Link>
  )
}
