/**
 * lyra-plugin-system: battery-included filesystem + shell + skills tools.
 *
 * Native plugin shape: exports a default `register(ctx)` consumed by lyra's
 * loader. The ctx exposes `registerTool`, `registerListener`, `addHook`. Tools
 * registered here ride through the same approval/permission floor as any other
 * registered tool; chat.tsx hooks `pre_tool_call` to enforce.
 */

import { LocalBackend, type NativePlugin, type ToolDef } from 'lyra-core'
import {
  findAgentBrowserOrNull,
  makeBrowserBack,
  makeBrowserClick,
  makeBrowserConsole,
  makeBrowserGetImages,
  makeBrowserNavigate,
  makeBrowserPress,
  makeBrowserScroll,
  makeBrowserSnapshot,
  makeBrowserType,
  makeBrowserVision,
} from './browser'
import { makeCodeExecute } from './code-execute'
import { WorkingDirState } from './cwd-state'
import { makeDelegateTask } from './delegate'
import { makeFsPatch, makeFsRead, makeFsSearch, makeFsWrite } from './fs'
import { makeSessionSearch } from './session-search'
import { makeShellRun } from './shell'
import { makeShellCd } from './shell-cd'
import {
  makeShellProcessKill,
  makeShellProcessList,
  makeShellProcessOutput,
  makeShellProcessStart,
} from './shell-process'
import { makeSkillsList, makeSkillsView } from './skills'
import { makeSkillsManage } from './skills-manage'
import { makeClarify, makeTodo } from './todo'
import { makeVisionAnalyze } from './vision'
import { makeWebFetch } from './web-fetch'

export {
  makeFsRead,
  makeFsWrite,
  makeFsPatch,
  makeFsSearch,
  makeShellRun,
  makeShellCd,
  makeShellProcessStart,
  makeShellProcessOutput,
  makeShellProcessList,
  makeShellProcessKill,
  makeTodo,
  makeClarify,
  makeSkillsList,
  makeSkillsView,
  makeSkillsManage,
  makeSessionSearch,
  makeCodeExecute,
  makeDelegateTask,
  makeVisionAnalyze,
  makeWebFetch,
  makeBrowserNavigate,
  makeBrowserSnapshot,
  makeBrowserClick,
  makeBrowserType,
  makeBrowserScroll,
  makeBrowserBack,
  makeBrowserPress,
  makeBrowserGetImages,
  makeBrowserVision,
  makeBrowserConsole,
}
export { WorkingDirState, resolveCwd } from './cwd-state'
export { killAllProcesses } from './shell-process'
export { isBrowserAvailable } from './browser'

const plugin: NativePlugin = {
  name: 'system',
  register: ctx => {
    const workspaceRoot = ctx.workspaceRoot ?? process.cwd()
    // Phase 9.5: pull sandbox backend from context. If chat.tsx didn't supply
    // one (legacy callers, tests), fall back to LocalBackend (passthrough)
    // so existing behaviour is preserved exactly.
    const sandbox = ctx.sandbox ?? new LocalBackend()
    // Phase 9.6: ONE shared cwd state for shell.cd / shell.run / code.execute
    // / shell.process_start. shell.cd mutates; the others read at handler
    // invocation time. Tests that pass `cwd: '<path>'` get a private state
    // automatically (resolveCwd promotes string → state per tool).
    const cwdState = new WorkingDirState(workspaceRoot)
    const fsDeps = { workspaceRoot, agentDir: ctx.agentDir }
    const skillsDeps = {
      importsClaudeCode: ctx.imports.claudeCode,
      disabled: ctx.skillsDisabled.current,
    }
    const tools: ToolDef[] = [
      makeFsRead(fsDeps) as ToolDef,
      makeFsWrite(fsDeps) as ToolDef,
      makeFsPatch(fsDeps) as ToolDef,
      makeFsSearch(fsDeps) as ToolDef,
      makeShellRun({ cwd: cwdState, sandbox }) as ToolDef,
      makeShellCd({ cwd: cwdState, agentDir: ctx.agentDir }) as ToolDef,
      makeWebFetch() as ToolDef,
      makeTodo() as ToolDef,
      makeClarify() as ToolDef,
      makeSkillsList(skillsDeps) as ToolDef,
      makeSkillsView(skillsDeps) as ToolDef,
      makeSkillsManage({
        importsClaudeCode: ctx.imports.claudeCode,
        configPath: ctx.configPath,
        disabledRef: ctx.skillsDisabled,
      }) as ToolDef,
      makeSessionSearch({ activityLogPath: ctx.activityLogPath }) as ToolDef,
      makeCodeExecute({ cwd: cwdState, sandbox }) as ToolDef,
      makeShellProcessStart({ cwd: cwdState, sandbox }) as ToolDef,
      makeShellProcessOutput() as ToolDef,
      makeShellProcessList() as ToolDef,
      makeShellProcessKill() as ToolDef,
      makeVisionAnalyze({
        visionInfer: ctx.visionInfer ?? null,
        agentDir: ctx.agentDir,
      }) as ToolDef,
    ]
    // Skip browser.* registration when the agent-browser binary is absent
    // (dev installs that skipped `bun install`). Pass workspaceRoot so the
    // detector looks under the agent's actual checkout dir — enigma's
    // harness daemon boots from $HOME, not the lyra workspace, so without
    // the override `findAgentBrowser` misses the colocated node_modules
    // and the brain falls back to web.fetch every time. Resolve the bin
    // path ONCE here and pass it through `binPath` so per-call spawns
    // don't re-search PATH (which would re-miss for the same reason).
    const browserBin = findAgentBrowserOrNull(workspaceRoot)
    if (browserBin) {
      tools.push(
        makeBrowserNavigate({ binPath: browserBin }) as ToolDef,
        makeBrowserSnapshot({ binPath: browserBin }) as ToolDef,
        makeBrowserClick({ binPath: browserBin }) as ToolDef,
        makeBrowserType({ binPath: browserBin }) as ToolDef,
        makeBrowserScroll({ binPath: browserBin }) as ToolDef,
        makeBrowserBack({ binPath: browserBin }) as ToolDef,
        makeBrowserPress({ binPath: browserBin }) as ToolDef,
        makeBrowserGetImages({ binPath: browserBin }) as ToolDef,
        makeBrowserConsole({ binPath: browserBin }) as ToolDef,
        makeBrowserVision({ binPath: browserBin, visionInfer: ctx.visionInfer ?? null }) as ToolDef,
      )
    }
    if (ctx.delegateFactory) {
      tools.push(
        makeDelegateTask({
          makeBrain: ctx.delegateFactory,
          agents: ctx.claudeAgents,
        }) as ToolDef,
      )
    }
    for (const t of tools) ctx.registerTool(t)
  },
}

export default plugin
