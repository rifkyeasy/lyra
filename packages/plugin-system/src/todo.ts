import type { ToolDef } from 'lyra-core'
import { z } from 'zod'

/**
 * In-session task list. Brain uses this to plan multi-step work, similar to
 * Claude Code's TodoWrite. State lives in-memory per session; when the
 * process exits, the list is gone (this is intentional; persistent task
 * state belongs in `memory.save` with `project` type).
 */

interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

const TodoSchema = z.object({
  action: z
    .enum(['add', 'update', 'list', 'clear'])
    .describe('add a task, update its status, list current tasks, or clear all.'),
  id: z.string().optional().describe('Required for update; the task id returned from add.'),
  text: z.string().optional().describe('Task description. Required for add.'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .optional()
    .describe('Required for update.'),
})

export function makeTodo(): ToolDef<z.infer<typeof TodoSchema>> {
  const tasks: TodoItem[] = []
  let next = 1
  return {
    name: 'todo',
    description:
      'Manage an in-session task list. Use to plan multi-step work; the list is shown to the user via post-tool-call rendering. Tasks reset when chat exits.',
    searchHint: 'todo task plan steps tracker',
    schema: TodoSchema,
    handler: args => {
      if (args.action === 'add') {
        if (!args.text) return { ok: false, error: 'text is required for add' }
        const id = String(next++)
        tasks.push({ id, text: args.text, status: 'pending' })
        return { ok: true, data: { id, tasks } }
      }
      if (args.action === 'update') {
        if (!(args.id && args.status)) {
          return { ok: false, error: 'id + status required for update' }
        }
        const idx = tasks.findIndex(t => t.id === args.id)
        if (idx === -1) return { ok: false, error: `unknown task: ${args.id}` }
        tasks[idx] = { ...tasks[idx]!, status: args.status }
        return { ok: true, data: { tasks } }
      }
      if (args.action === 'clear') {
        tasks.length = 0
        return { ok: true, data: { tasks } }
      }
      return { ok: true, data: { tasks } }
    },
  }
}

const ClarifySchema = z.object({
  question: z.string().min(3).describe('Question to ask the operator.'),
  options: z
    .array(z.string())
    .optional()
    .describe('Optional multiple-choice options for the operator.'),
})

/**
 * `clarify` is the brain's escape hatch when it doesn't have enough info to
 * proceed. Phase 9.0 implementation surfaces the question via the tool result
 * (chat.tsx renders it as a system row); the operator can answer in their next
 * message. A future phase will add a structured pause.
 */
export function makeClarify(): ToolDef<z.infer<typeof ClarifySchema>> {
  return {
    name: 'clarify',
    description:
      'Ask the operator a question and surface it inline. Use when the next step requires information the brain does not have. The result echoes the question back for display; the operator answers in their next message.',
    searchHint: 'clarify ask question prompt operator',
    schema: ClarifySchema,
    handler: args => {
      return {
        ok: true,
        data: { question: args.question, options: args.options ?? null },
      }
    },
  }
}
