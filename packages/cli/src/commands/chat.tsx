/**
 * The Lyra chat TUI command. Boots an @opentui/solid renderer and renders the
 * (Nebula-derived) chat App; each submitted goal drives Lyra's agentic loop
 * (runGoal). Tool calls and results stream into the transcript as the agent
 * works — the same tool-call/tool-result rows Nebula's UI was built for.
 */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { loadConfig } from 'lyra-core'
import { ChatApp } from '../ui/app'
import { createChatState } from '../ui/state'
import { runGoal } from './agent'

export async function runChat(): Promise<void> {
  const cfg = loadConfig()
  const state = createChatState({
    initialSystem: `Lyra · ${cfg.network} · package ${cfg.packageId.slice(0, 10)}…  —  ask anything (e.g. "what's my balance and the best Sui yield?" or "send 0.005 SUI to myself"). "exit" to quit.`,
    identityLabel: 'lyra',
    approvalsMode: 'prompt',
  })

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    openConsoleOnError: false,
  })

  let exiting = false
  const handleExit = () => {
    if (exiting) return
    exiting = true
    try {
      renderer.stop?.()
    } catch {
      // best effort
    }
    process.exit(0)
  }

  const handleSubmit = async (goal: string): Promise<void> => {
    state.pushRow({ role: 'user', text: goal })
    state.setStatus('thinking')
    try {
      await runGoal(goal, {
        onEvent: (e) => {
          if (e.type === 'tool-call') {
            state.pushRow({ role: 'tool-call', text: '', toolName: e.name, args: e.args === '{}' ? '' : e.args })
          } else if (e.type === 'tool-result') {
            state.pushRow({ role: 'tool-result', text: e.text, failed: e.failed })
          } else if (e.type === 'assistant' && e.text.trim()) {
            state.pushRow({ role: 'assistant', text: e.text })
          }
        },
      })
      state.setStatus('idle')
    } catch (e) {
      state.pushRow({ role: 'system', text: `error: ${(e as Error).message}` })
      state.setStatus('error')
    }
  }

  await render(() => <ChatApp state={state} onSubmit={handleSubmit} onExit={handleExit} />, renderer)
  // render() resolves on mount; keep the process alive until the user exits.
  await new Promise<void>(() => {})
}
