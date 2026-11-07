import type {
  AdditionalInput, AppliedConfigReport, CancelReceipt, CloseResult, ContextBootstrap,
  ExecutionReceipt, ExecutionRef, ExecutionResult, ExecutionStatus, InputReceipt,
  InvocationInput, InvocationRequest, PreparedAgentHandle, ProvisioningPolicy, ProvisioningRequest,
  ReleaseResult, ResolvedAgentSpec, RuntimeCapabilities, RuntimeEvent, RuntimeOutcome,
  RuntimeRef, RuntimeRequest, SessionHandle, ValidationReport,
} from '@dentity/contracts';

/** Core depends on these logical ports, never a protocol SDK or an executable fallback. */
export interface AgentProvisioningPort {
  capabilities(request: ProvisioningRequest<{ readonly runtime: RuntimeRef }>): Promise<RuntimeOutcome<RuntimeCapabilities>>;
  validateSpec(request: ProvisioningRequest<{
    readonly runtime: RuntimeRef; readonly spec: ResolvedAgentSpec; readonly policy: ProvisioningPolicy;
  }>): Promise<RuntimeOutcome<ValidationReport>>;
  /** Missing required safeguards fail; preparation cannot silently install resources. */
  prepareAgent(request: ProvisioningRequest<{
    readonly runtime: RuntimeRef; readonly spec: ResolvedAgentSpec; readonly policy: ProvisioningPolicy; readonly idempotencyKey: string;
  }>): Promise<RuntimeOutcome<PreparedAgentHandle>>;
  inspectPreparedAgent(request: ProvisioningRequest<{ readonly handle: PreparedAgentHandle }>): Promise<RuntimeOutcome<AppliedConfigReport>>;
  releaseAgent(request: ProvisioningRequest<{ readonly handle: PreparedAgentHandle }>): Promise<RuntimeOutcome<ReleaseResult>>;
}

export interface AgentSessionPort {
  createSession(request: RuntimeRequest<{
    readonly handle: PreparedAgentHandle; readonly sessionId: string; readonly contextBootstrap: ContextBootstrap; readonly idempotencyKey: string;
  }>): Promise<RuntimeOutcome<SessionHandle>>;
  /** Revalidate current authorization/configuration; possession of an old handle is insufficient. */
  resumeSession(request: RuntimeRequest<{ readonly session: SessionHandle }>): Promise<RuntimeOutcome<SessionHandle>>;
  closeSession(request: RuntimeRequest<{ readonly session: SessionHandle }>): Promise<RuntimeOutcome<CloseResult>>;
}

export interface AgentExecutionPort {
  readInteractionEvents?(request:RuntimeRequest<{readonly execution:ExecutionRef;readonly cursor?:string}>):Promise<RuntimeOutcome<{events:readonly import('@dentity/contracts').InteractionDeliveryEvent[];cursor:string}>>;
  /** In-process wakeup hint only; consumers must read authenticated durable events. */
  onInteractionEvents?(listener:()=>void):()=>void;

  /** Adapter-owned durable history receipt, distinct from acceptance or generation. */
  getInputCommit?(request: RuntimeRequest<{ readonly execution: ExecutionRef; readonly batchId: string }>): Promise<RuntimeOutcome<{batchId:string;status:'committed'|'accepted'|'unknown'}>>;

  /** Validate all scope, session, target, input and trusted invocation bindings before dispatch.
   * Unknown acceptance is reconciled using the same execution ID/key, never blindly replayed.
   */
  submit(request: InvocationRequest<{
    readonly session: SessionHandle; readonly execution: ExecutionRef; readonly input: InvocationInput; readonly idempotencyKey: string;
  }>): Promise<ExecutionReceipt>;
  /** Unsupported subscription returns a typed error before opening a stream.
   * A stream error/end is not execution completion. Resume with cursor or poll as declared.
   */
  subscribe(request: RuntimeRequest<{
    readonly execution: ExecutionRef; readonly cursor?: string;
  }>): Promise<RuntimeOutcome<AsyncIterable<RuntimeEvent>>>;
  getStatus(request: RuntimeRequest<{ readonly execution: ExecutionRef }>): Promise<RuntimeOutcome<ExecutionStatus>>;
  appendInput(request: InvocationRequest<{
    readonly execution: ExecutionRef; readonly inputId: string; readonly input: AdditionalInput; readonly idempotencyKey: string;
  }>): Promise<InputReceipt>;
  cancel(request: RuntimeRequest<{ readonly execution: ExecutionRef; readonly reason: string }>): Promise<RuntimeOutcome<CancelReceipt>>;
  getResult(request: RuntimeRequest<{ readonly execution: ExecutionRef }>): Promise<RuntimeOutcome<ExecutionResult>>;
}

/** Optional session maintenance. A protocol ACK is not proof of applied compaction. */
export interface AgentSessionMaintenancePort {
  inspectContext(request:import('@dentity/contracts').RuntimeMaintenanceRequest):Promise<RuntimeOutcome<import('@dentity/contracts').RuntimeContextInspection>>;
  requestMaintenance(request:import('@dentity/contracts').RuntimeMaintenanceRequest):Promise<RuntimeOutcome<import('@dentity/contracts').RuntimeMaintenanceReceipt>>;
  getMaintenanceStatus(request:import('@dentity/contracts').RuntimeMaintenanceRequest):Promise<RuntimeOutcome<import('@dentity/contracts').RuntimeMaintenanceReceipt>>;
}

/** Optional platform -> interaction Runtime delivery, independent of user submit. */
export interface AgentInteractionEventPort {
  acceptInteractionEvent(request:RuntimeRequest<{readonly session:SessionHandle;readonly event:import('@dentity/contracts').RuntimeInteractionEvent;readonly idempotencyKey:string}>):Promise<import('@dentity/contracts').InteractionEventReceipt>;
  getInteractionEvent(request:RuntimeRequest<{readonly session:SessionHandle;readonly event:import('@dentity/contracts').RuntimeInteractionEvent;readonly idempotencyKey:string}>):Promise<import('@dentity/contracts').InteractionEventReceipt>;
}
