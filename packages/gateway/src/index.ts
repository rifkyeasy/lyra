export {
  GATEWAY_VERSION,
  type GatewaySession,
  type GatewayState,
  type CreateSessionOpts,
  type ProvisionInputs,
  createSession,
  transitionToProvisioned,
  transitionToReady,
  transitionToShuttingDown,
} from './state'

export {
  type ProvisionRequest,
  type ProvisionEnvelope,
  type VerifyOpts,
  type VerifyResult,
  type VerifyChatOpts,
  type VerifyApprovalOpts,
  type VerifyAdminTickOpts,
  provisionMessageDigest,
  verifyProvisionSig,
  chatMessageDigest,
  verifyChatSig,
  approvalResponseDigest,
  verifyApprovalSig,
  adminTickDigest,
  verifyAdminTickSig,
} from './auth'

export {
  type GatewayEvent,
  type GatewayEventKind,
  type Subscriber,
  EventHub,
} from './events'

export type {
  RuntimeAdapter,
  RuntimeConfig,
  ChatTurnInput,
  ChatTurnResult,
} from './runtime'

export { StubRuntime } from './stub-runtime'

export { RealRuntime, type RealRuntimeOpts } from './real-runtime'

export {
  type BuildRuntimeOpts,
  type BuiltRuntime,
  buildLyraRuntime,
} from './build-runtime'

export {
  type ApprovalDecision,
  type ApprovalRequestPayload,
  type PendingApproval,
  ApprovalRelay,
} from './approval-relay'

export { type ServerDeps, createGatewayServer } from './server'

export {
  type BootstrapMode,
  type BuildBootstrapScriptOpts,
  type BuildBootstrapScriptResult,
  BOOTSTRAP_SUCCESS_MARKER_PREFIX,
  BOOTSTRAP_DONE_MARKER,
  BOOTSTRAP_FAIL_MARKER,
  BOOTSTRAP_PROGRESS_LOG,
  BOOTSTRAP_FAIL_KEYWORDS,
  BOOTSTRAP_STAGE_MARKERS,
  buildBootstrapScript,
} from './bootstrap'

export {
  type BuildUpgradeScriptOpts,
  type BuildUpgradeScriptResult,
  UPGRADE_SUCCESS_MARKER_PREFIX,
  UPGRADE_DONE_MARKER,
  UPGRADE_FAIL_MARKER,
  UPGRADE_PROGRESS_LOG,
  UPGRADE_FAIL_KEYWORDS,
  buildUpgradeScript,
} from './upgrade-script'

export { type Heartbeat, type StartHeartbeatOpts, startHeartbeat } from './heartbeat'

export {
  type BuildRelaunchScriptOpts,
  type BuildRelaunchScriptResult,
  RELAUNCH_DONE_MARKER,
  RELAUNCH_FAIL_MARKER,
  RELAUNCH_PROGRESS_LOG,
  RELAUNCH_SUCCESS_MARKER_PREFIX,
  buildGatewayRelaunchScript,
} from './relaunch-script'
