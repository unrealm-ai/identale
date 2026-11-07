import type {JsonlJournal} from '@dentity/runtime-builtin';
import type {EmployeeLifecycleTransition} from './lifecycle-control.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AccountUser,EntityService,WorkspaceService,TaskService} from '@dentity/application';
import type {DirectorySnapshots} from '../directory-sync/service.js';
import type {Store} from '../store.js';
import type {ModelProfileService} from '../model-profiles.js';
import type {SkillResources} from '../skill-resources.js';
import type {McpResources} from '../mcp-resources.js';
import type {EmployeeChannelService} from '../employee-channels/service.js';
import type {CapabilityConfigService} from '../capability-config.js';
import type {TriggerService} from '../triggers/service.js';
import type {ChannelIngressSupervisor} from '../channel-loop/ingress-supervisor.js';
import type {SqliteConversationRepository} from '../adapters/sqlite/conversation-repository.js';
export interface ConfigurationComposition {
 server:FastifyInstance;store:Store;profiles:ModelProfileService;skills:SkillResources;mcp:McpResources;
 channels:EmployeeChannelService;snapshots:DirectorySnapshots;capabilities:CapabilityConfigService;triggers?:TriggerService;
 entities:EntityService;workspaces:WorkspaceService;auth:(r:FastifyRequest)=>AccountUser;
}
export interface SplitComposition {
 role:'platform'|'runtime';
 notificationKey?:string;
 notificationGroups?:(actorId:string,path:string,request?:{method:'POST';body:unknown})=>Promise<unknown>;
 lifecycleTransition?:EmployeeLifecycleTransition;
 assertNewAdmission?:()=>void;
 hasConfiguration?:()=>boolean;
 whenConfigured?:(work:()=>void)=>void;
 authenticate:(request:FastifyRequest,store:Store)=>AccountUser;
 initialize:(composition:ConfigurationComposition)=>Promise<void>;
 resource?:(kind:'skill'|'mcp',body:unknown)=>Promise<unknown>;
 runtimeReady?:(composition:{store:Store;profiles:ModelProfileService;channels:EmployeeChannelService;ingress:ChannelIngressSupervisor;conversations:SqliteConversationRepository;tasks:TaskService;triggers:TriggerService;journal:JsonlJournal})=>void;
}
