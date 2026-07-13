import matter from 'gray-matter'
import type { MemoryFrontmatter, MemoryPartition, MemoryTopic } from './types'

export function parseTopic(partition: MemoryPartition, slug: string, raw: string): MemoryTopic {
  const parsed = matter(raw)
  const fm = parsed.data as Partial<MemoryFrontmatter>
  if (!(fm.name && fm.description && fm.type)) {
    throw new Error(`Topic file ${slug} missing required frontmatter (name/description/type)`)
  }
  return {
    partition,
    slug,
    frontmatter: fm as MemoryFrontmatter,
    body: parsed.content.trimStart(),
  }
}

export function stringifyTopic(topic: MemoryTopic): string {
  return matter.stringify(topic.body, topic.frontmatter as Record<string, unknown>)
}
