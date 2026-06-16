import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { NebulaConfig } from 'nebula-ai-core'

export interface RenderConfigOpts {
  header?: string
}

/**
 * Serialize an NebulaConfig into a `~/.nebula/config.ts` file body.
 *
 * Phase 6.6: the config lives at `~/.nebula/config.ts` which is outside any
 * workspace, so it MUST NOT import `nebula-ai-core` (the import won't
 * resolve from `~/.nebula/`). We emit a plain `export default { ... }` object;
 * the runtime loader treats it as `NebulaConfig` directly.
 */
export function renderConfigTs(cfg: NebulaConfig, opts: RenderConfigOpts = {}): string {
  const header = opts.header ?? ''
  const operatorLine = cfg.operator ? `  operator: ${JSON.stringify(cfg.operator)},\n` : ''
  // Emit either the operator's chosen sandbox config OR an annotated
  // "OPTION 1/2/3" block so the operator can opt in by uncommenting. Default
  // mode stays `none` (passthrough); documentation IS the UX.
  const sandboxBlock = renderSandboxBlock(cfg.sandbox)
  return `${header ? `${header}\n\n` : ''}export default {
  identity: ${JSON.stringify(cfg.identity)},
  network: ${JSON.stringify(cfg.network)},
  storage: { network: ${JSON.stringify(cfg.storage.network)} },
  brain: {
    provider: ${JSON.stringify(cfg.brain.provider)},
    model: ${JSON.stringify(cfg.brain.model)},
  },
  plugins: ${JSON.stringify(cfg.plugins)},
  tools: ${JSON.stringify(cfg.tools)},
  imports: { claudeCode: ${cfg.imports.claudeCode} },
${operatorLine}${sandboxBlock}}
`
}

function renderSandboxBlock(sandbox: NebulaConfig['sandbox']): string {
  // Phase 11: deploy-target sandbox metadata (id/providerAddress/endpoint/
  // snapshotName) OR Phase 9.5 limb-sandbox mode = anything non-default → emit
  // verbatim. Only surface the doc-comment template when the operator has
  // touched neither.
  const hasNonDefaultLimbMode = sandbox?.mode && sandbox.mode !== 'none'
  if (hasNonDefaultLimbMode) {
    return `  sandbox: ${JSON.stringify(sandbox, null, 2).replace(/\n/g, '\n  ')},\n`
  }
  // Fresh install: write the active default + commented examples for the
  // other tiers. Operator can opt in by uncommenting and editing.
  return `  sandbox: { mode: 'none' },
  // ---------------------------------------------------------------------------
  //  Limb sandbox (Phase 9.5). Defense-in-depth beneath the permission floor:
  //  even when the modal grants 'allow session' or YOLO disables prompts,
  //  the sandbox profile/container blocks writes outside an allowlist.
  //  All shell.run / code.execute / shell.process_start spawns route through
  //  the chosen backend. fs.* and browser.* still run on the host (PathGuard
  //  applies). Override at runtime via NEBULA_SANDBOX_MODE=os|docker|none.
  //
  //  OPTION 1: none (default): passthrough, fastest, permission floor only.
  //
  //  OPTION 2: os (macOS sandbox-exec / seatbelt). Allows writes to agentDir +
  //    cwd + /tmp/nebula-* + /var/folders. Denies reads of ~/.ssh, ~/.aws,
  //    ~/Library/Keychains, ~/.config/gcloud. Linux bubblewrap pending.
  //  sandbox: { mode: 'os' },
  //
  //  OPTION 3: docker (long-lived container per session), every shell-class
  //    spawn through 'docker exec'. Auto-detects Docker Desktop or Podman.
  //    Default image 'nikolaik/python-nodejs:python3.11-nodejs20' (matches
  //    hermes; ~700 MB; bash + python3 + node + npm + git on standard PATH).
  //    Override with 'oven/bun:1' (~250 MB) if you only need bun/ts.
  //    'dockerMountWorkspace: true' bind-mounts your launch cwd into
  //    /workspace (off by default for max isolation). 'dockerRuntimePath'
  //    forces a specific runtime binary. Resource caps are unset by default
  //    (container competes fairly with host work). Set them to mirror hermes'
  //    production hardening: dockerCpu=1, dockerMemoryMb=5120, dockerDiskMb=
  //    51200 (Linux+overlay2 only). dockerNoNetwork=true blocks all internet
  //    access from the container (max paranoia for code.execute).
  //  sandbox: {
  //    mode: 'docker',
  //    dockerImage: 'nikolaik/python-nodejs:python3.11-nodejs20',
  //    dockerMountWorkspace: false,
  //    // dockerRuntimePath: '/opt/homebrew/bin/podman',
  //    // dockerCpu: 1,           // CPU cores cap
  //    // dockerMemoryMb: 5120,   // 5 GB memory cap
  //    // dockerDiskMb: 51200,    // 50 GB disk cap (Linux + overlay2 only)
  //    // dockerNoNetwork: true,  // block all network from inside container
  //  },
  // ---------------------------------------------------------------------------
`
}

export async function writeConfigTs(
  path: string,
  cfg: NebulaConfig,
  opts: RenderConfigOpts = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, renderConfigTs(cfg, opts), 'utf8')
}
