import { Footer } from '@/components/Footer'
import { SubNavbar } from '@/components/SubNavbar'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ARTICLES, ARTICLES_BY_SLUG, type Block } from '../articles'

export function generateStaticParams() {
  return ARTICLES.map(a => ({ slug: a.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const a = ARTICLES_BY_SLUG[slug]
  if (!a) return { title: 'Research · lyra' }
  return {
    title: `${a.title} · lyra`,
    description: a.subtitle,
    openGraph: { title: a.title, description: a.subtitle, type: 'article' },
  }
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const article = ARTICLES_BY_SLUG[slug]
  if (!article) notFound()

  const more = ARTICLES.filter(a => a.slug !== article.slug).slice(0, 2)

  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <SubNavbar label="research" />

      <article className="mx-auto w-full max-w-[720px] px-6 pb-16 pt-28 sm:px-8 md:pt-32">
        {/* Eyebrow + title */}
        <Link
          href="/research"
          className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink)]"
        >
          ← {article.tag}
        </Link>
        <h1
          className="mt-5 font-display text-[clamp(30px,4.4vw,46px)] font-light leading-[1.1] tracking-[-0.02em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 24, "WONK" 0' }}
        >
          {article.title}
        </h1>
        <p className="mt-4 text-[clamp(17px,2.1vw,21px)] font-light leading-[1.5] text-[var(--color-ink-2)]">
          {article.subtitle}
        </p>

        {/* Byline */}
        <div className="mt-7 flex items-center gap-3 border-b border-[var(--color-border)] pb-7">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-ink)] font-display text-[15px] lowercase text-[var(--color-cream)]"
          >
            ly
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[14px] font-medium text-[var(--color-ink)]">Lyra</span>
            <span className="text-[12.5px] text-[var(--color-ink-3)]">
              {article.readMin} min read · {article.date}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="mt-9 flex flex-col">
          {article.body.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
        </div>

        {/* Footer nav */}
        <div className="mt-14 border-t border-[var(--color-border)] pt-8">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-ink-3)]">
            Keep reading
          </span>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {more.map(m => (
              <Link
                key={m.slug}
                href={`/research/${m.slug}`}
                className="group flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-paper)] p-5 transition-colors hover:border-[var(--color-ink-3)]"
              >
                <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
                  {m.tag}
                </span>
                <span
                  className="mt-2 font-display text-[18px] font-light leading-[1.15] tracking-tight text-[var(--color-ink)]"
                  style={{ fontVariationSettings: '"opsz" 72' }}
                >
                  {m.title}
                </span>
                <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-ink)]">
                  Read
                  <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </span>
              </Link>
            ))}
          </div>
          <Link
            href="/research"
            className="mt-8 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)]"
          >
            ← All research
          </Link>
        </div>
      </article>

      <Footer />
    </main>
  )
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'h2':
      return (
        <h2
          className="mb-3 mt-9 font-display text-[clamp(22px,2.8vw,28px)] font-normal leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 72' }}
        >
          {block.text}
        </h2>
      )
    case 'quote':
      return (
        <blockquote className="my-6 border-l-2 border-[var(--color-ink)] pl-5 font-display text-[clamp(19px,2.4vw,24px)] font-light italic leading-[1.4] text-[var(--color-ink)]">
          {block.text}
        </blockquote>
      )
    case 'ul':
      return (
        <ul className="my-3 flex list-disc flex-col gap-2 pl-6 text-[var(--color-ink-2)] marker:text-[var(--color-ink-3)]">
          {block.items.map((it, i) => (
            <li key={i} className="text-[clamp(16px,2vw,18px)] leading-[1.6]">
              {it}
            </li>
          ))}
        </ul>
      )
    case 'code':
      return (
        <pre className="my-5 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-paper)] p-4 font-mono text-[13px] leading-relaxed text-[var(--color-ink)]">
          <code>{block.code}</code>
        </pre>
      )
    default:
      return (
        <p className="mb-5 text-[clamp(17px,2.1vw,19px)] leading-[1.7] text-[var(--color-ink-2)]">
          {block.text}
        </p>
      )
  }
}
