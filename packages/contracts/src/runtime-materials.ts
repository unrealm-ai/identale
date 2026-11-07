import type { ContentRef, RuntimeAuthorizationContext } from '@dentity/domain';
import type { ResolvedAgentSpec } from './runtime-provisioning.js';
import type { ExecutionRef } from './runtime-execution.js';
/** Registered Skills can contain 100 MiB files plus base64/JSON envelope overhead. */
export const MAX_RUNTIME_MATERIAL_BYTES=150*1024*1024;
/** Separate negotiated wire contract. Secrets stay in private configuration storage, never events. */
export interface RuntimeBlobRef { sha256:string; byteLength:number }
export interface RuntimeMaterialContent { ref:ContentRef; blob:RuntimeBlobRef }
export interface RuntimeConfigurationPackage {
  version:1; configurationId:string;
  model:{protocol?:import('./model-input.js').ModelProtocol;provider:string;modelId:string;apiKey:string;baseUrl?:string;inputCapabilities?:import('./model-input.js').ModelInputCapabilities};
  skills:readonly RuntimeMaterialContent[];
  mcp:readonly {ref:ContentRef;blob:RuntimeBlobRef}[];
}
export interface RuntimeRunMaterials {
  workItemLaunchGate?:{version:1;workspaceId:string};
  workItems?:import('./work-items.js').WorkItemAccess;
  groupHistory?:import("./group-sharing.js").GroupHistoryAccess;
  triggerHistory?:import("./group-sharing.js").GroupHistoryAccess;
  version:1; configurationId:string; context:RuntimeAuthorizationContext;
  spec:ResolvedAgentSpec; execution:ExecutionRef;
  contents:readonly RuntimeMaterialContent[];
  assets:readonly {assetId:string;kind:string;name?:string;reads:Partial<Record<'content'|'summary'|'transcript',RuntimeBlobRef & {mediaType:string} | {state:'pending'|'no_permission'|'not_available'|'failed';reason?:string;missing?:readonly RuntimeBlobRef[]}>>}[];
  history:unknown;
  continuation?:import('./human-confirmation.js').HumanContinuation;
}
export interface RuntimePreparationStatus {modelProtocol?:import('./model-input.js').ModelProtocol;modelInput?:readonly ('text'|'image')[];version:1;hostId:string;configurationId:string;fetched:string;prepared:string|null;resources:'ready'|'not_ready';sdk:'initializes_on_submit';reason?:string;missing?:readonly RuntimeBlobRef[]}
