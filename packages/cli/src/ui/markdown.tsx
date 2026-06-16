import { For } from 'solid-js'
import { parseMarkdown } from './markdown-parse'

export {
  parseMarkdown,
  MD_COLORS,
  type MdSegment,
} from './markdown-parse'

/**
 * Render parsed markdown segments as opentui spans inside an existing
 * `<text>` block. Caller owns the wrapping `<text>` (so wrapMode + flexGrow
 * stay configurable).
 *
 * Why custom rather than opentui's built-in `<markdown>`: nebula already
 * renders assistant text inside a row that has a fixed-width prefix
 * gutter; switching to `<markdown>` would break the indent and gutter
 * alignment because it owns its own layout. A custom renderer that emits
 * spans keeps the existing AssistantTextRow flow intact.
 */
export function MarkdownSegments(props: { text: string }) {
  const segments = () => parseMarkdown(props.text)
  return (
    <For each={segments()}>
      {seg => {
        // opentui's SpanProps type omits fg/bold/italic but the runtime
        // accepts them. Cast through an object spread to bypass the check.
        const styles = {
          ...(seg.fg ? { fg: seg.fg } : {}),
          ...(seg.bold ? { bold: true } : {}),
          ...(seg.italic ? { italic: true } : {}),
        } as Record<string, unknown>
        return <span {...styles}>{seg.text}</span>
      }}
    </For>
  )
}
