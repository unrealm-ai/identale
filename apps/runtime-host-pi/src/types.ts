import type { ResolvedAgentSpec, RuntimeRequest } from '@dentity/contracts';
import type { RegisteredMcpServer, RegisteredSkill } from './resources.js';
import type { RuntimeAuthorizationContext, ContentRef, InvocationContext } from '@dentity/domain';
import type { ResolvedExecutionResource } from './execution-resources.js';

/** Only trusted prepared configuration can supply these. Never journal this value. */
export interface ResolvedModelProfile { protocol?:import('@dentity/contracts').ModelProtocol;provider: string; modelId: string; apiKey: string; baseUrl?: string;inputCapabilities?:import('@dentity/contracts').ModelInputCapabilities }
export interface TrustedResolver {
  assets?(context:RuntimeAuthorizationContext):Promise<readonly {assetId:string;kind:string;name?:string}[]>;
  asset?(assetId:string,kind:'content'|'summary'|'transcript',context:RuntimeAuthorizationContext):Promise<Response|Exclude<import('./asset-materializer.js').HostAssetResult,{state:'ready'}>>;
  history?(context:RuntimeAuthorizationContext):Promise<import('@dentity/application').TriggerHistoryManifest|null>;
  verify(request: RuntimeRequest<unknown, RuntimeAuthorizationContext>): Promise<boolean>;
  content(ref: ContentRef, context: RuntimeAuthorizationContext): Promise<string>;
  modelAvailable?(context:RuntimeAuthorizationContext):Promise<boolean>;
  mcp?(ref:ContentRef,context:RuntimeAuthorizationContext):Promise<RegisteredMcpServer>;
  model(ref: ContentRef, context: RuntimeAuthorizationContext): Promise<ResolvedModelProfile>;
  storeOutput(text: string, context: InvocationContext): Promise<ContentRef>;
}
export interface DriverInvocation {
  captureInvalidModelResponses?:boolean;
  humanRequestId?:string;
  replanOnly?:boolean;
  assets?:readonly {assetId:string;kind:string;name?:string}[];
  spec: ResolvedAgentSpec;
  context: InvocationContext;
  instructions: string;
  prompt: string;
  profile: ResolvedModelProfile;
  sessionDirectory: string;
  resume: boolean;
  mcpServers: RegisteredMcpServer[];
  skills: RegisteredSkill[];
  executionResource?: ResolvedExecutionResource;
}
export interface DriverSteeringInput { inputId: string; revision: number; contentDigest: string; nonce: string; text: string }
export interface DriverControl { done: Promise<string|{kind:'needs_human';requestId:string}|{kind:'work_item_boundary';boundary:import('@dentity/contracts').WorkItemBoundary}>; cancel(reason?:'host_cancel'|'host_timeout'): Promise<'requested' | 'confirmed' | 'unknown'>; steer?(input: DriverSteeringInput): Promise<'queued' | 'closed' | 'unknown'> }
export type DriverEvent = {type:'model_diagnostic';diagnostic:import('./model-diagnostics.js').ModelFailureDiagnostic}|{type:'human_request';requestId:string;question:import('@dentity/contracts').HumanQuestion} | { type: 'output_delta' | 'progress' | 'before_tool' | 'before_request' | 'tool_unknown'; text: string }
  | { type: 'input_queued'; inputId: string; revision: number; contentDigest: string }
  | { type: 'input_applied'; inputId: string; revision: number; contentDigest: string; requestId: string; messageEntryId: string };
export interface PiDriver { readonly supportsSteer?: boolean; start(input: DriverInvocation, emit: (event: DriverEvent) => void | Promise<void>): DriverControl }
export const ADAPTER_VERSION = '0.2.0';
export const PI_VERSION = '1.4.0';

/** A rejected model request after settled, paired tools is a known failure, not an unknown external operation. */
export class ProviderInvocationError extends Error { constructor(readonly httpStatus:number){super('Registered model provider rejected request');this.name='ProviderInvocationError';} }
