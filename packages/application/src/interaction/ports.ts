import type { AuthorizationContext } from '@dentity/domain';
import type { AgentExecutionPort, AgentProvisioningPort, AgentSessionPort, AgentSessionMaintenancePort,AgentInteractionEventPort } from '../runtime-ports.js';
import type { TaskScope } from '../tasks/index.js';
export type Conversation = {id:string;mode:'demo'|'real';created_at:number;expires_at:number;workspace_id:string;entity_id:string;user_id:string|null;owner_key:string;channel:string;scope_json:string|null};
export type Turn = {id:string;conversation_id:string;operation_id:string;text:string;mode:'demo'|'real';status:string;request_json:string|null;output:string|null;error:string|null;created_at:number;epoch:number;reply_id?:string|null;canonicalInputId?:string;inputHash?:string;scope_json?:string|null};
export interface ConversationMessage {id:string;role:string;text:string;simulated:number;createdAt:number}
export interface ConversationRepository {
  transaction<T>(fn:()=>T):T;
  expiredConversationIds(at:number):string[];
  findConversation(id:string,scope:TaskScope,at:number):{id:string}|undefined;
  conversationMode(conversationId:string):{mode:string}|undefined;
  findHistoryMessage(id:string,conversationId:string,at:number):{id:string;role:string;text:string;expiresAt:number}|undefined;
  recoverPreparing():Turn[];
  purgeExpired(at:number):void;
  get(id:string):Conversation|undefined;
  findByOperation(scope:TaskScope,operationId:string):Conversation|undefined;
  adoptNotificationScope?(id:string,scope:TaskScope):void;
  create(id:string,scope:TaskScope,operationId:string,at:number,mode:'demo'|'real',expiresAt:number):void;
  getOrCreateWeb(scope:TaskScope,id:string,operationId:string,at:number,expiresAt:number,beforeCreate:()=>void):{created:boolean;conversation:Conversation};
  list(scope:TaskScope,at:number):Conversation[];
  notice(id:string,conv:Conversation,text:string,at:number):void;
  content(id:string,conversationId:string,at:number):{text:string}|undefined;
  putContent(id:string,conv:Conversation,text:string):void;
  turn(id:string,conversationId?:string):Turn|undefined;
  findTurn(conversationId:string,operationId:string):Turn|undefined;
  activeTurns(conversationId:string):Turn[];
  nextEpoch(conversationId:string):number;
  createTurn(turn:Turn,ignoreConflict:boolean):boolean;
  updateTurn(id:string,status:string,error:string|null):void;
  failPreparing(id:string,error:string):void;
  saveRequest(id:string,requestJson:string):void;
  succeed(id:string,output:string,replyId?:string):void;
  addMessage(id:string,conv:Conversation,role:string,text:string,at:number,simulated:boolean,ignoreConflict?:boolean):void;
  messages(conversationId:string,at:number):ConversationMessage[];
  getRetainedRealMessage(conversationId:string,messageId:string,at:number):{text:string}|undefined;
}
export interface InteractionRuntimeProvider {
  acceptBusinessEvent?(scope:TaskScope,conversationId:string,operationId:string,event:import("@dentity/contracts").RuntimeInteractionEvent):Promise<{receipt:import("@dentity/contracts").InteractionEventReceipt;text?:string}>;
  onWork?(listener:()=>void):()=>void;
  readonly toolNames:readonly string[];
  resolve(scope:TaskScope,conversation:Conversation):Promise<{runtime:AgentProvisioningPort & AgentSessionPort & AgentExecutionPort & Partial<AgentInteractionEventPort>;revision:string;runtimeRef:import("@dentity/contracts").RuntimeRef}>;
  resolveRecorded?(scope:TaskScope,conversation:Conversation,revision:string):ReturnType<InteractionRuntimeProvider['resolve']>;
  prepareSession(scope:TaskScope,conversation:Conversation,request:import("@dentity/contracts").RuntimeRequest<Record<string,never>>,at:number):Promise<import("@dentity/contracts").SessionHandle>;
  resolveMaintenance?(conversation:Conversation):Promise<{runtime:AgentSessionMaintenancePort;revision:string}>;
  readOutput(id:string,context:AuthorizationContext):string;
  shutdown():Promise<void>;
  purgeExpired(conversationIds:readonly string[]):void;
}

export interface InteractionEntityPort { getRuntimeDefinition(workspaceId:string,entityId:string):{name:string;description:string;interactionRuntime:string}|undefined }
