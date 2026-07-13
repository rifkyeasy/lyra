import { type DangerousMatch, type NoMatch, detectDangerousCommand } from './dangerous'

/**
 * Permission system core. Three resolution modes:
 *   - 'strict': dangerous patterns always denied, no prompt
 *   - 'prompt': dangerous patterns prompt the user once / for the session / deny
 *   - 'off' (YOLO): dangerous patterns allowed silently
 *
 * Approvals are scoped per-session via a Set of allowed pattern keys. The
 * service is UI-agnostic; chat.tsx wires `setPrompter()` to its own modal.
 * In headless contexts (tests, scripted CLI) the default prompter denies.
 */
export type PermissionMode = 'strict' | 'prompt' | 'off'
export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny'

export interface PermissionRequest {
  kind:
    | 'shell.run'
    | 'shell.process'
    | 'code.execute'
    | 'fs.write'
    | 'fs.patch'
    | 'chain.send'
    | 'chain.swap'
    | 'chain.write'
  command?: string
  path?: string
  /** For value-moving tx tools: human-readable amount (e.g. "0.05 Sui"). */
  amount?: string
  /** For value-moving tx tools: 0x recipient or contract address. */
  recipient?: string
  /** For value-moving tx tools: token symbol. */
  token?: string
  /** Description of why approval is needed (e.g. "delete in root path"). */
  reason: string
  /**
   * Deterministic policy floor: when true, the on-chain policy engine has
   * flagged this action as material-risk and it MUST be approved by a human
   * regardless of the session permission mode — even under YOLO. In `strict`
   * mode a forced request is denied outright. This is how fund controls are
   * enforced in code rather than left to the model (CLAUDE.md).
   */
  force?: boolean
}

export type PermissionPrompter = (req: PermissionRequest) => Promise<PermissionDecision>

export interface PermissionServiceOpts {
  mode: PermissionMode
  prompter?: PermissionPrompter
}

const DEFAULT_DENY_PROMPTER: PermissionPrompter = async () => 'deny'

export interface PermissionResolution {
  allowed: boolean
  reason?: string
  via: 'yolo' | 'allow' | 'session-allow' | 'once' | 'deny' | 'strict-deny'
}

type DangerousResult = DangerousMatch | NoMatch

export class PermissionService {
  private mode: PermissionMode
  private prompter: PermissionPrompter
  private readonly sessionAllowed = new Set<string>()

  constructor(opts: PermissionServiceOpts) {
    this.mode = opts.mode
    this.prompter = opts.prompter ?? DEFAULT_DENY_PROMPTER
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  setPrompter(p: PermissionPrompter): void {
    this.prompter = p
  }

  isYolo(): boolean {
    return this.mode === 'off'
  }

  getMode(): PermissionMode {
    return this.mode
  }

  /**
   * Resolve a permission for a tool call.
   *   - `force` (policy floor): material-risk per the on-chain policy — prompt
   *     beneath any mode; deny in strict; even YOLO must approve.
   *   - YOLO ('off'): otherwise always allow.
   *   - Strict: dangerous pattern => deny, otherwise allow.
   *   - Prompt: dangerous pattern OR shell.run => consult `prompter`,
   *     honour session-allow on subsequent identical signatures.
   */
  async resolve(req: PermissionRequest): Promise<PermissionResolution> {
    const dangerous = req.command ? detectDangerousCommand(req.command) : { match: false as const }

    // Signature for session-allow tracking. When the request matched a
    // dangerous pattern, key on the PATTERN (e.g. "delete in root path") so
    // the user's "allow session" covers every match of the same pattern for
    // the rest of the session, not just the literal command.
    const sigKey = dangerous.match ? this.signature(req, dangerous.key) : this.signature(req)
    if (this.sessionAllowed.has(sigKey)) {
      return { allowed: true, via: 'session-allow' }
    }

    if (req.force) {
      return this.resolveForced(req, sigKey)
    }

    if (this.mode === 'off') return { allowed: true, via: 'yolo' }

    // Value-moving on-chain tools: ALWAYS prompt in `prompt` mode regardless
    // of dangerous-pattern match (which is regex-based and doesn't fire here).
    // In `strict` mode they're denied — strict means "no autonomous spending".
    const isValueMoving =
      req.kind === 'chain.send' || req.kind === 'chain.swap' || req.kind === 'chain.write'
    if (this.mode === 'strict') {
      return this.resolveStrict(dangerous, isValueMoving)
    }
    return this.resolvePromptMode(req, dangerous, isValueMoving, sigKey)
  }

  /**
   * Deterministic policy floor: a `force`-flagged action is material-risk per
   * the on-chain policy engine and requires human approval BENEATH the session
   * mode — even under YOLO. strict denies it outright; otherwise it consults the
   * prompter regardless of mode. Fund controls live in code.
   */
  private async resolveForced(
    req: PermissionRequest,
    sigKey: string,
  ): Promise<PermissionResolution> {
    if (this.mode === 'strict') {
      return {
        allowed: false,
        reason: `${req.reason} (policy: approval required, denied in strict mode)`,
        via: 'strict-deny',
      }
    }
    const decision = await this.prompter(req)
    return this.applyDecision(decision, sigKey)
  }

  /** strict mode: value-moving + dangerous patterns are denied; everything else allowed. */
  private resolveStrict(dangerous: DangerousResult, isValueMoving: boolean): PermissionResolution {
    if (isValueMoving) {
      return {
        allowed: false,
        reason: 'value-moving tx denied in strict mode',
        via: 'strict-deny',
      }
    }
    if (dangerous.match) {
      return { allowed: false, reason: dangerous.description, via: 'strict-deny' }
    }
    return { allowed: true, via: 'allow' }
  }

  /**
   * prompt mode: dangerous patterns + every shell-class invocation + every
   * value-moving on-chain tx consult the prompter.
   */
  private async resolvePromptMode(
    req: PermissionRequest,
    dangerous: DangerousResult,
    isValueMoving: boolean,
    sigKey: string,
  ): Promise<PermissionResolution> {
    if (dangerous.match) {
      const decision = await this.prompter({ ...req, reason: dangerous.description })
      return this.applyDecision(decision, sigKey)
    }
    if (
      req.kind === 'shell.run' ||
      req.kind === 'shell.process' ||
      req.kind === 'code.execute' ||
      isValueMoving
    ) {
      const decision = await this.prompter(req)
      return this.applyDecision(decision, sigKey)
    }
    return { allowed: true, via: 'allow' }
  }

  /**
   * Approve a fs.write/fs.patch path explicitly (skip prompter). Tests use
   * this; chat.tsx wires it through the approval modal.
   */
  approveSession(req: PermissionRequest): void {
    this.sessionAllowed.add(this.signature(req))
  }

  private applyDecision(
    decision: PermissionDecision,
    sigKey: string,
  ): { allowed: boolean; reason?: string; via: 'session-allow' | 'once' | 'deny' } {
    if (decision === 'allow-session') {
      this.sessionAllowed.add(sigKey)
      return { allowed: true, via: 'session-allow' }
    }
    if (decision === 'allow-once') return { allowed: true, via: 'once' }
    return { allowed: false, reason: 'rejected in approval modal', via: 'deny' }
  }

  private signature(req: PermissionRequest, dangerousKey?: string): string {
    // For dangerous-pattern matches, key on the pattern type ("delete in
    // root path", "recursive delete", ...) so allow-session generalises
    // across every command that triggers the same pattern. Without this,
    // each unique rm path was a fresh decision.
    if (dangerousKey) return `${req.kind}|dangerous:${dangerousKey}`
    return [req.kind, req.command ?? '', req.path ?? '', req.recipient ?? '', req.token ?? ''].join(
      '|',
    )
  }
}
