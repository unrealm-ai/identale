import type { RuntimeInteractionEvent, RuntimeMaintenanceRequest } from '@dentity/contracts';
import type {BuiltinInputQueue} from './input-queue.js';
import type {DiagnosticPort} from '@dentity/application';
import type { JsonlJournal } from './journal.js';
import type { AuthorizationContext, ContentRef, InvocationContext, RuntimeAuthorizationContext } from '@dentity/domain';

export interface ModelToolCall { readonly id: string; readonly name: string; readonly arguments: unknown }
/** Platform trigger correlation; only adapter-generated protocol messages are synthetic. */
export interface PlatformMessageSource { readonly source:'platform'; readonly synthetic:boolean;readonly initiatedBy?:'adapter'; readonly eventId:string; readonly taskId:string; readonly runId:string }
export interface ModelImageRef {readonly assetId:string;readonly version:string}
export type ModelMessage = (
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ModelToolCall[] }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string }) & { readonly images?:readonly ModelImageRef[]; readonly platform?: PlatformMessageSource; /** Trusted adapter metadata, never model-supplied or sent as wire fields. */ readonly contextSource?:{readonly kind:'user_input'|'human_notice'|'human_pending'|'business_notice';readonly id:string;readonly occurredAt?:number} };
/** Deliberately small, validated schema subset. Unknown keywords are rejected at registration. */
export interface ToolSchema {
  readonly type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, ToolSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: ToolSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxItems?: number;
}
export interface ModelTool { readonly name: string; readonly description: string; readonly parameters: ToolSchema }
export interface ModelClientPort {
  complete(input: { readonly messages: readonly ModelMessage[]; readonly tools: readonly ModelTool[]; /** History declarations only; provider MUST set tool_choice=none. */ readonly protocolTools?:readonly ModelTool[]; readonly maxOutputTokens: number; readonly retryPurpose?:'summary'; readonly signal: AbortSignal },control?:{readonly beforeAttempt?:()=>Promise<void>}): Promise<{
    readonly text?: string;
    readonly finishReason?: string;
    readonly toolCalls?: readonly ModelToolCall[];
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }>;
}
export interface StoredRecord { readonly version: number; readonly value: unknown }
/** Dedicated private runtime namespace; implementations must atomically compare/write and preserve JSON. */
export interface SessionStore {
  get(key: string): Promise<StoredRecord | undefined>;
  compareAndSet(key: string, expectedVersion: number | null, value: unknown): Promise<boolean>;
  compareAndSetMany(changes: readonly {key:string;expectedVersion:number|null;value:unknown}[]): Promise<boolean>;
}
export interface OperationRecord {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly status: 'pending' | 'completed';
  readonly result?: unknown;
}
/** Independent of session retention. Never expire receipts while task side effects can survive. */
export interface OperationStore {
  get(operationId: string): Promise<OperationRecord | undefined>;
  claim(record: OperationRecord): Promise<boolean>;
  complete(operationId: string, result: unknown): Promise<void>;
}
export type BuiltinInvocationContext=InvocationContext&{/** Immutable inputs consumed before this model call, never a live/latest-message lookup. */readonly consumedTurnIds?:readonly string[]};
export interface BuiltinTool extends ModelTool {
  readonly kind: 'task' | 'knowledge_read';
  execute(args: Readonly<Record<string, unknown>>, context: BuiltinInvocationContext, control: { readonly operationId: string; readonly signal: AbortSignal }): Promise<unknown>;
  /** Must read authoritative application receipts; unknown NEVER authorizes replay. */
  reconcile?(operationId: string, context: BuiltinInvocationContext): Promise<{ readonly status: 'completed'; readonly result: unknown } | { readonly status: 'unknown' }>;
}
export interface RuntimeLimits {
  readonly maxModelRounds: number;
  readonly maxToolCalls: number;
  readonly maxDurationMs: number;
  readonly toolTimeoutMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;

  readonly maxHistoryBytes: number;
}
export interface BuiltinRuntimeOptions {
  readonly assertOwner?:()=>void;
  readonly onInteractionEvent?:()=>void;
  readonly previousOwnerUnavailable?:()=>boolean;
  readonly isOwnerAlive?:(owner:{pid:number;instanceId:string;startIdentity?:string})=>boolean;

  authorizeHistoryBatch?:(batchId:string,context:AuthorizationContext)=>boolean;
  readonly diagnostics?:DiagnosticPort;
  readonly modelClient?: ModelClientPort;
  readonly sessionStore: SessionStore;
  readonly journal: JsonlJournal;
  readonly operationStore: OperationStore;
  readonly tools: readonly BuiltinTool[];
  /** Re-evaluated on every public operation and every tool dispatch, including cached receipts. */
  readonly authorizeMaintenance?: (request: RuntimeMaintenanceRequest) => Promise<boolean>;
  /** Host must confirm the prior job is terminal with no live lease, not just an expired request. */
  readonly authorizeMaintenanceReplacement?: (current: RuntimeMaintenanceRequest, previous: RuntimeMaintenanceRequest) => Promise<boolean>;
  /** Production host atomically rechecks its maintenance lease/scope and applies metadata CAS. */
  readonly publishMaintenance?: (request: RuntimeMaintenanceRequest, changes: readonly {key:string;expectedVersion:number|null;value:unknown}[]) => Promise<boolean>;
  readonly authorize: (context: RuntimeAuthorizationContext, action: string) => Promise<boolean>;
  readonly inputQueue?:BuiltinInputQueue;
  readonly sessionScopeBinding?:(context:AuthorizationContext)=>string;
  readonly authorizePlatformEvent?: (event:RuntimeInteractionEvent, context:InvocationContext)=>Promise<boolean>;
  readonly readContent: (ref: ContentRef, context: AuthorizationContext) => Promise<string>;
  readonly writeOutput: (text: string, context: InvocationContext) => Promise<ContentRef>;
  /** Trusted external messages/reference projection, committed with the current input before model invocation. Never called merely by sending a notice. */
  readonly prepareInputHistory?: (messages:readonly ModelMessage[],context:AuthorizationContext,projectedNoticeIds:readonly string[])=>Promise<readonly ModelMessage[]>;
  /** Must revoke/expire obsolete source-derived history, not merely truncate it. Runs before every model call. */
  readonly filterHistory: (messages: readonly ModelMessage[], context: AuthorizationContext) => Promise<readonly ModelMessage[]>;
  /** Required ACL/redaction for application tool receipts before they reach the model. */
  readonly filterToolResult: (result: unknown, context: InvocationContext, toolName: string) => Promise<unknown>;
  readonly limits?: Partial<RuntimeLimits>;
  readonly now?: () => number;
}
