import {resolveHumanTarget,authorizeHumanTarget} from './human-target.js';
import{BusinessOAuthService,feishuOAuthTransport}from'./business-resources/oauth.js';
import{ApplicationResourceAccess}from'./business-resources/application-access.js';
import{DingTalkApplicationAssetTransport}from'./business-resources/dingtalk.js';
import{registerBusinessOAuthRoutes}from'./business-resources/routes.js';
import{businessResource,isBusinessResource,type ResourceAuthorizationRequest}from'./business-resources/authorization.js';
import {WorkItemArtifacts} from './work-items/artifacts.js';
import {createJournalIndex} from './adapters/sqlite/journal-index.js';
import{TaskArtifacts}from'./task-artifacts.js';
import{BusinessResultNotifications}from'./notifications/business-results.js';
import{WorkItemNotifications}from'./work-items/notifications.js';
import {WorkItemConfiguration}from'./work-items/configuration.js';
import {WorkItemsService}from'./work-items/service.js';
import {registerWorkItemRoutes}from'./work-items/routes.js';
import{GroupSharingConfiguration,registerSharingConfiguration}from'./group-sharing/configuration.js';
import{GroupHistoryService}from'./group-sharing/history.js';
import{createRecipientChoice}from'./human-recipient-router.js';
import {registerHumanConfiguration} from './human-configuration.js';
import {HumanChannelNotifications} from './human-channel.js';
import {HumanConfirmation} from './human-confirmation.js';
import {TriggerResultNotifications} from './notifications/trigger-results.js';
import {NotificationTargetCodec} from './notifications/targets.js';
import {registerNotificationCatalog} from './notifications/catalog.js';
import {DiscoveredGroups} from './channel-loop/discovered-groups.js';
import type {SplitComposition} from './split/composition.js';
import {RecentConversationReadService} from '@dentity/application';
import {SqliteRecentConversationRead} from './adapters/sqlite/recent-conversation-read.js';
import {registerWorkbench} from './workbench.js';
import {diskObserver} from './channel-loop/disk-observer.js';
import {technicalRetention} from './channel-loop/technical-retention.js';
import {cleanupBuiltinTechnical} from './adapters/sqlite/builtin-stores.js';
import type {TaskRequestContext} from '@dentity/application';
import {PlatformAssetService} from './assets/service.js';
import {ChannelAssetTransport} from './assets/channel.js';
import {RuntimeProcessOwner} from './channel-loop/runtime-process-owner.js';
import {TriggerService} from './triggers/service.js';
import {TriggerStore} from './triggers/store.js';
import {registerTriggerRoutes} from './triggers/routes.js';
import {DirectorySnapshots} from './directory-sync/service.js';
import {registerDirectorySyncRoutes} from './directory-sync/routes.js';
import {McpResources} from './mcp-resources.js';
import {registerWorkspaceResources} from './workspace-resources.js';
import {SkillResources} from './skill-resources.js';
import {SqliteTaskCompletionNotifications} from './adapters/sqlite/task-completion-notifications.js';
import {TaskCompletionNotifications,ChannelMessageLoop,scopeFromJson,type Conversation} from '@dentity/application';
import {SqliteGroupContext} from './channel-loop/group-context.js';
import {SqliteMessageLoopRepository} from './channel-loop/repository.js';
import {ChannelIngressSupervisor} from './channel-loop/ingress-supervisor.js';
import {createSdkIngress} from './adapters/channels/ingress/sdk-ingress.js';
import type {ChannelIngressFactory} from './channel-loop/ingress-types.js';
import {ChannelTaskAuthorization} from './channel-loop/authorization.js';
import {withDirectoryAccessPolicy} from './directory/channel-policy.js';
import {EmployeeChannelService} from './employee-channels/service.js';
import {EmployeeChannelRepository} from './employee-channels/repository.js';
import {registerEmployeeChannelRoutes} from './employee-channels/routes.js';
import {FeishuAppRegistration,registerFeishuAppRegistrationRoutes} from './employee-channels/feishu-registration.js';
import type {EmployeeChannelOptions} from './employee-channels/types.js';
import { ChannelIntegrationService, type ChannelIntegrationOptions } from '@dentity/application';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountService, WorkspaceService, EntityService, TaskService, TaskError, createInteractionService, type TaskRuntimeClient } from '@dentity/application';
import { dirname, join } from 'node:path';
import { JsonlJournal, OpenAICompatibleModelClient } from '@dentity/runtime-builtin';
import { registerEmployeeLifecycle } from './employee-lifecycle.js';
import { registerAccounts } from './accounts.js';
import { registerEmployeeConfigurationRoutes } from './employee-configuration.js';
import { registerEmployeeCreationRoutes } from './employee-creation.js';
import { EmployeeChannelCreationDrafts } from './employee-channels/creation-drafts.js';
import { registerTasks } from './tasks.js';
import { registerAdminTasks } from './admin-tasks.js';
import { registerInteractionRoutes } from './interaction-routes.js';
import { CapabilityConfigService, CapabilityConfigError, registerCapabilityConfigRoutes, type ApprovedResource } from './capability-config.js';
import { ModelProfileService, registerModelProfileRoutes, type ModelProfileOptions } from './model-profiles.js';
import { HttpTaskRuntime, registerRuntimeResolver, type RuntimeHostConfig } from './runtime-http.js';
import { Store } from './store.js';
import { registerHttpSecurity, validateHttpSecurity } from './http/security.js';
import { registerLifecycle } from './lifecycle.js';
import {ContextMaintenanceService,type ContextMaintenanceOptions} from './context-maintenance.js';
import {SqliteScheduleRepository} from './adapters/sqlite/schedule-repository.js';
import { SqliteAccountRepository } from './adapters/sqlite/account-repository.js';
import { SqliteWorkspaceRepository } from './adapters/sqlite/workspace-repository.js';
import { SqliteEntityRepository } from './adapters/sqlite/entity-repository.js';
import { SqliteTaskRepository } from './adapters/sqlite/task-repository.js';
import { SqliteConversationRepository } from './adapters/sqlite/conversation-repository.js';
import { SqliteTaskRuntimeContextRetention } from './adapters/sqlite/task-runtime-context-retention.js';
import { passwordHasher } from './adapters/security/argon2-password-hasher.js';
import { createBuiltinInteractionProvider, type InteractionOptions } from './adapters/builtin-interaction-provider.js';
import {FileDiagnostics,diagnosticFetch} from './adapters/diagnostics.js';
import {diagnosticInteraction} from './adapters/diagnostic-interaction.js';

export interface ControlPlaneConfig extends InteractionOptions {
  /** Host-owned independent business account + resource/audience authorization. Never inferred from bot validation. */
  businessResources?:import('./business-resources/authorization.js').BusinessResourceAccess;
  /** Exact administrator-registered callback URL. User tokens remain encrypted in runtime storage. */
  businessOAuth?:{redirectUri:string};
  /** Local opt-in, not a workspace-editable configuration or model credential. */
  captureInvalidModelResponses?:boolean;
  /** Trusted deployment composition; omitted for the legacy all-in-one test entry. */
  split?:SplitComposition;
  /** Optional, host-controlled channel composition; this does not install public callback routes. */
  channels?: ChannelIntegrationOptions;
  directorySync?:{automatic?:boolean};
  onDirectorySnapshots?:(service:DirectorySnapshots)=>void;
  onChannelIntegrationService?: (service: ChannelIntegrationService) => void;
  employeeChannels?:EmployeeChannelOptions;
  /** Trusted test composition only; production always uses the official SDK runner. */
  channelIngressFactory?:ChannelIngressFactory;
  onChannelIngressSupervisor?:(supervisor:ChannelIngressSupervisor)=>void;
  onChannelMessageLoop?:(service:ChannelMessageLoop)=>void;
  onEmployeeChannelService?:(service:EmployeeChannelService)=>void;
  maintenance?:ContextMaintenanceOptions;
  onMaintenanceService?:(service:ContextMaintenanceService)=>void;
  onTaskCompletionNotifications?:(service:TaskCompletionNotifications)=>void;
  approvedResources?: readonly ApprovedResource[];
  triggers?:{allowLoopbackHttp?:boolean;automatic?:boolean};
  onTriggerService?:(service:TriggerService)=>void;
  skillResourceRoot?:string;
  mcpResources?:{allowedOrigins?:readonly string[];allowLoopbackHttp?:boolean;fetch?:typeof fetch};
  modelProfiles?: ModelProfileOptions;
  runtimeHost?: RuntimeHostConfig;
  runtime?: TaskRuntimeClient;
  pollIntervalMs?: number;
  onService?: (service: TaskService) => void;
  onHumanConfirmationService?:(service:HumanConfirmation)=>void;
  onWorkItemService?:(service:WorkItemsService)=>void;
  databasePath: string;
  /** Trusted server configuration; never supplied by a conversation/API request. */
  builtinRecordRoot?: string;
  origin: string;
  secureCookies: boolean;
  sessionTtlMs: number;
  now: () => number;
}

/** One monolith composition root. Application modules never assemble their adapters. */
export async function bootstrap(server: FastifyInstance, config: ControlPlaneConfig): Promise<void> {
  validateHttpSecurity(config);
  const ttl = config.conversationTtlMs ?? 0;
  if (!Number.isSafeInteger(ttl) || ttl < 0) throw new Error('conversationTtlMs must be nonnegative (0 disables expiry)');
  const store = new Store(config.databasePath, config.split?{role:config.split.role}:undefined);
  let runtimeOwner:Pick<RuntimeProcessOwner,'previousOwnerUnavailable'|'assert'|'release'>;try{runtimeOwner=config.split?.role==='platform'?{previousOwnerUnavailable:false,assert:()=>{},release:()=>{}}:new RuntimeProcessOwner(store);}catch(error){store.close();throw error;}
  const ownedDiagnostics=config.diagnostics?undefined:new FileDiagnostics(join(dirname(store.databasePath),'diagnostics'));
  const diagnostics=config.diagnostics??ownedDiagnostics!;
  ownedDiagnostics?.startMonitoring();
  server.addHook('onClose',async()=>{await ownedDiagnostics?.close();});
  let lifecycleRegistered = false;
  let ingress:ChannelIngressSupervisor|undefined;
  let stopSnapshots:(()=>Promise<void>)|undefined;
  try {
    await registerHttpSecurity(server, config);
    const security = {id: randomUUID, token: () => randomBytes(32).toString('base64url'), digest: (value: string) => createHash('sha256').update(value).digest('hex')};
    const accountRepository = new SqliteAccountRepository(store);
    const workItemConfiguration = new WorkItemConfiguration(store);
    const workspaces = new WorkspaceService(new SqliteWorkspaceRepository(store, workItemConfiguration), accountRepository, security, config.now);
    const accounts = new AccountService(accountRepository, workspaces, security, passwordHasher, config.now, config.sessionTtlMs);
    if(config.split?.role!=='runtime')await accounts.initialize();
    let triggerService:TriggerService|undefined;
    const profiles = new ModelProfileService(store, {...config.modelProfiles,diagnostics});
    const employeeChannels=new EmployeeChannelService(new EmployeeChannelRepository(store),{...config.employeeChannels,diagnostics,fetch:diagnosticFetch(diagnostics,config.employeeChannels?.fetch??fetch),...(config.employeeChannels?.masterKey??config.modelProfiles?.masterKey?{masterKey:config.employeeChannels?.masterKey??config.modelProfiles!.masterKey!}:{}),...(config.now?{now:config.now}:{})});
    config.onEmployeeChannelService?.(employeeChannels);
    const uploadedSkills=new SkillResources(store,config.skillResourceRoot??join(dirname(store.databasePath),'skill-resources'));
    const mcpResources=new McpResources(store,{...config.mcpResources,...(config.modelProfiles?.masterKey?{masterKey:config.modelProfiles.masterKey}:{}),allowLoopbackHttp:config.mcpResources?.allowLoopbackHttp??config.modelProfiles?.allowLoopbackHttp??false});
    new TriggerStore(store,config.modelProfiles?.masterKey,config.now);
    const capabilities = new CapabilityConfigService(store, config.approvedResources,employeeChannels,uploadedSkills,mcpResources,diagnostics,config.now);
    server.addHook('onClose',()=>capabilities.close());
    if(config.split?.role!=='runtime')registerWorkspaceResources(server,uploadedSkills,mcpResources,(request,w)=>{const u=auth(request);workspaces.get(u.id,w);return u.id;});
    employeeChannels.setAccessCheck((scope,connection,kind)=>capabilities.authorizeChannel(scope,connection,kind));
    const channelIntegration=config.channels?new ChannelIntegrationService({...config.channels,accessPolicy:withDirectoryAccessPolicy(config.channels.accessPolicy,capabilities)}):undefined;
    if(channelIntegration)config.onChannelIntegrationService?.(channelIntegration);
    const entityRepository = new SqliteEntityRepository(store);
    const entities = new EntityService(entityRepository, accountRepository, workspaces, security, config.now);
    const cookieName = config.secureCookies ? '__Host-dentity_session' : 'dentity_session';
    const auth = (request: FastifyRequest) => config.split?.role==='runtime'?config.split.authenticate(request,store):accounts.authenticate(request.cookies[cookieName]);
    const snapshots=new DirectorySnapshots(store,()=>employeeChannels.directorySources(),config.now,diagnostics,id=>employeeChannels.directorySource(id));employeeChannels.setDirectorySnapshots(snapshots);if(config.split?.role!=='runtime')snapshots.reconcile();config.onDirectorySnapshots?.(snapshots);
    // A verification-only test composition supplies no directory transport: no implicit background egress.
    const automaticSync=config.split?.role==='runtime'?false:config.directorySync?.automatic??!(config.employeeChannels?.verifyApplication&&!config.employeeChannels.fetch&&!config.employeeChannels.adapterFactory);
    const directoryTimer=automaticSync?setInterval(()=>{void snapshots.tick().catch(()=>{});},60000):undefined;directoryTimer?.unref();
    let snapshotsStopped=false;stopSnapshots=async()=>{if(snapshotsStopped)return;snapshotsStopped=true;if(directoryTimer)clearInterval(directoryTimer);await snapshots.stop();};
    server.addHook('preClose',stopSnapshots);
    if(config.split?.role!=='runtime')registerDirectorySyncRoutes(server,snapshots,(request,w)=>{workspaces.get(auth(request).id,w);});
    server.addHook('onResponse',async(request,reply)=>{if(reply.statusCode>=400)return;const p=request.params as{workspaceId?:string;entityId?:string};if(config.split?.role!=='runtime'&&!['GET','HEAD'].includes(request.method)&&p.workspaceId){snapshots.reconcile();const path=request.url.split('?')[0]!;if(automaticSync&&p.entityId&&/\/(?:channels|directory-access|capability-packages)(?:\/|$)/.test(path))snapshots.configurationChanged(p.workspaceId,p.entityId);}});

    const notificationCodec=new NotificationTargetCodec(config.split?.notificationKey??(config.employeeChannels?.masterKey??config.modelProfiles?.masterKey?Buffer.from(config.employeeChannels?.masterKey??config.modelProfiles!.masterKey!).toString('base64'):undefined));
    let workItems:WorkItemsService|undefined;
    registerWorkItemRoutes(server,workItemConfiguration,{...(config.split?{role:config.split.role}:{}),reader:(r,w)=>{const u=auth(r);workspaces.get(u.id,w);return u.id;},manager:(r,w)=>{const u=auth(r);if(!['owner','admin'].includes(workspaces.get(u.id,w).role))throw new TaskError(403,'role_forbidden');return u.id;},...(config.split?.notificationGroups?{relay:config.split.notificationGroups}:{}),human:()=>human,runtime:()=>workItems});
    const sharing=new GroupSharingConfiguration(store,employeeChannels,config.split?.notificationKey??Buffer.from(config.employeeChannels?.masterKey??config.modelProfiles?.masterKey??randomBytes(32)).toString('base64'),config.now);
    registerSharingConfiguration(server,sharing,{...(config.split?{role:config.split.role}:{}),manager:(r,w,e)=>{const u=auth(r);entities.requireManager(u.id,w,e);return u.id;},...(config.split?.notificationGroups?{relay:config.split.notificationGroups}:{})});
    const discoveredGroups=config.split?.role==='platform'?undefined:new DiscoveredGroups(store);
    registerNotificationCatalog(server,{channels:employeeChannels,codec:notificationCodec,...(discoveredGroups?{groups:discoveredGroups}:{}),...(config.split?{role:config.split.role}:{}),manager:(request,w,e)=>{const user=auth(request);entities.requireManager(user.id,w,e);return user.id;},...(config.split?.notificationGroups?{relay:config.split.notificationGroups}:{})});
    const notificationOptions={codec:notificationCodec,assertCurrent:(w:string,e:string,t:import('./notifications/targets.js').NotificationTarget)=>{const r=employeeChannels.repository.byId(t.connectionId);if(!r||r.workspaceId!==w||r.entityId!==e||r.appId!==t.appId||employeeChannels.currentBindingVersion(r.id)!==t.bindingVersion)throw new TaskError(409,'notification_target_stale');}};
    if(config.split?.role!=='runtime'){
    registerHumanConfiguration(server,store,employeeChannels,(request,w,e)=>{entities.requireManager(auth(request).id,w,e);},capabilities);
    const requireManager = (request: FastifyRequest, workspaceId: string, entityId: string) => entities.requireManager(auth(request).id, workspaceId, entityId);
    await registerAccounts(server, {accounts, workspaces, entities, auth, cookieName, secureCookies: config.secureCookies, sessionTtlMs: config.sessionTtlMs});
    registerEmployeeLifecycle(server,{store,entities,channels:employeeChannels,auth,now:config.now,...(config.split?.lifecycleTransition?{transition:config.split.lifecycleTransition}:{})});
    const channelDrafts = new EmployeeChannelCreationDrafts(employeeChannels, {...config.employeeChannels, ...(config.employeeChannels?.masterKey ?? config.modelProfiles?.masterKey ? {masterKey: config.employeeChannels?.masterKey ?? config.modelProfiles!.masterKey!} : {})});
    server.addHook('onClose', async () => { channelDrafts.close(); });
    registerEmployeeCreationRoutes(server, {store, entities, workspaces, profiles, capabilities, employeeChannels, channelDrafts, auth,trigger:()=>triggerService});
    registerEmployeeConfigurationRoutes(server, {entities, profiles, capabilities, currentUser: auth});
    registerWorkbench(server,{store,entities,profiles,workspaces,auth,now:config.now});
    await registerModelProfileRoutes(server, profiles, {requireManager, currentUser:auth,
      canManageWorkspace:(request,workspaceId)=>!!workspaces.get(auth(request).id,workspaceId),
      requireWorkspaceMember:(request,workspaceId)=>{workspaces.get(auth(request).id,workspaceId);},
      requireWorkspaceManager:(request,workspaceId)=>{workspaces.get(auth(request).id,workspaceId);},
    });
    await registerCapabilityConfigRoutes(server, capabilities, {requireManager, currentUser: auth,requireWorkspaceManager:(request,workspaceId)=>{workspaces.get(auth(request).id,workspaceId);}});
    const feishuRegistration = new FeishuAppRegistration(employeeChannels, {...config.employeeChannels,
      ...(config.employeeChannels?.masterKey ?? config.modelProfiles?.masterKey ? {masterKey: config.employeeChannels?.masterKey ?? config.modelProfiles!.masterKey!} : {})},
      (w,e,a)=>{entities.requireManager(a,w,e);capabilities.assertActive({workspaceId:w,entityId:e});});
    server.addHook('preClose',async()=>{feishuRegistration.close();});
    registerFeishuAppRegistrationRoutes(server,feishuRegistration,(request,w,e)=>{const user=auth(request);entities.requireManager(user.id,w,e);return user.id;});
    await registerEmployeeChannelRoutes(server,employeeChannels,{requireReader:(request,w,e)=>{const user=auth(request);entities.requireReader(user.id,w,e);return{canManage:!!workspaces.get(user.id,w)};},requireManager:(request,workspaceId,entityId)=>{const user=auth(request);entities.requireManager(user.id,workspaceId,entityId);if(!['GET','DELETE'].includes(request.method))capabilities.assertActive({workspaceId,entityId});return user.id;}});

    }
    if(config.split?.role==='platform'){
      const triggers=new TriggerService(store,undefined,capabilities,config.modelProfiles?.masterKey,config.now,notificationOptions);triggerService=triggers;
      await registerTriggerRoutes(server,triggers,(r,w,e)=>{if(e)entities.requireManager(auth(r).id,w,e);else workspaces.get(auth(r).id,w);},{...config.triggers,mode:'configuration'});
      await config.split.initialize({server,store,profiles,skills:uploadedSkills,mcp:mcpResources,channels:employeeChannels,snapshots,triggers,capabilities,entities,workspaces,auth});
      server.addHook('onClose',()=>store.close());
      lifecycleRegistered=true;
      return;
    }
    if(config.split?.role==='runtime')await config.split.initialize({server,store,profiles,skills:uploadedSkills,mcp:mcpResources,channels:employeeChannels,snapshots,capabilities,entities,workspaces,auth});

    const journal = new JsonlJournal({
      root: config.builtinRecordRoot ?? join(dirname(store.databasePath), 'builtin-records'),
      // A copied database has a different write lock even when its persistent ID matches.
      ownerId: JSON.stringify([store.databaseId, store.databasePath]),
      serialize: fn => store.transaction(fn),
      index:createJournalIndex(store),
    });
    const groupHistory=new GroupHistoryService(store,sharing,config.now,journal);
    const conversations = new SqliteConversationRepository(store, journal, config.now);
    conversations.initialize(ttl);
    let tasks: TaskService;
    const hostRuntime = config.runtimeHost ? new HttpTaskRuntime(store, profiles, config.runtimeHost, config.now, {
      eventTrace:v=>diagnostics.event({stage:'runtime',phase:'point',traceId:v.taskId,messageId:v.runId,taskId:v.taskId,runId:v.runId,sessionId:v.sessionId,operation:'runtime.events.read',state:v.ok?'succeeded':'failed',outcome:v.ok?'success':'failure',metrics:{requestedCursor:v.cursor,returnedThrough:v.returnedThrough,count:v.count}}),
      task: id => tasks.getRuntimeTask(id),
      todoStartFact:(taskId,runId)=>tasks.getRuntimeTodoStartFact(taskId,runId),
      preparationResources:(w,e)=>{const resources=capabilities.resourceSelection(w,capabilities.list(w,e).filter(p=>p.enabled)).map(x=>x.resource);return{skills:resources.flatMap(r=>r.kind==='skill'?[{resourceId:r.resourceId,version:r.version,digest:r.digest}]:[]),mcpServers:resources.flatMap(r=>r.kind==='mcp'?[{serverRef:r.serverRef,allowedTools:r.allowedTools,...(r.version?{version:r.version}:{})}]:[])};},
      executionThinkingLevel: (workspaceId,entityId) => entityRepository.find(workspaceId,entityId)?.executionThinkingLevel ?? (()=>{throw new TaskError(404,'entity_not_found');})(),
      input: (id, revision) => { const text = tasks.getRuntimeInput(id, revision); return text === undefined ? undefined : {text}; },
      retainedMessage: (conversationId, messageId) => conversations.getRetainedRealMessage(conversationId, messageId, config.now()),
      skill:(workspaceId,ref)=>config.split?.resource?config.split.resource('skill',{workspaceId,ref}):uploadedSkills.read(workspaceId,ref),
      filterCapabilities:(workspaceId,entityId,snapshot)=>capabilities.filterStartup(workspaceId,entityId,snapshot),
      mcp:(workspaceId,ref)=>config.split?.resource?config.split.resource('mcp',{workspaceId,resourceId:ref.resourceId,version:ref.version}):mcpResources.resolve(workspaceId,ref.resourceId,ref.version),
    }) : undefined;
    const channelAssets=new ChannelAssetTransport({robotCode:scope=>employeeChannels.assetRobotCode(scope),accessToken:scope=>employeeChannels.assetAccessToken(scope),assertSource:scope=>employeeChannels.assertAssetSource(scope),...(config.employeeChannels?.fetch?{fetch:config.employeeChannels.fetch}:{})});
    const businessKey=config.employeeChannels?.masterKey??config.modelProfiles?.masterKey;
    if(config.businessOAuth&&!businessKey)throw Error('business_oauth_key_required');
    const businessOAuth=config.businessOAuth?new BusinessOAuthService(store,businessKey!,{redirectUri:config.businessOAuth.redirectUri,application:scope=>employeeChannels.businessOAuthApplication(scope),assertSource:scope=>employeeChannels.assertAssetSource(scope)},feishuOAuthTransport(config.employeeChannels?.fetch??fetch),config.now):undefined;
    const businessAccess=config.businessResources??new ApplicationResourceAccess(store,{resolveApplication:request=>employeeChannels.businessResourceApplication(request.source),transport:(provider,options)=>provider==='dingtalk'?new DingTalkApplicationAssetTransport(options):undefined,assertSource:scope=>employeeChannels.assertAssetSource(scope),...(config.employeeChannels?.fetch?{fetch:config.employeeChannels.fetch}:{}),now:config.now});
    const assets=new PlatformAssetService(store,join(dirname(store.databasePath),'message-assets'),channelAssets,{now:config.now,assertSource:scope=>employeeChannels.assertAssetSource(scope),...(businessAccess?{businessResources:businessAccess}:{})});
    // Adapter availability is not a claim that scopes or any particular object ACL are granted.
    const applicationConfiguration={providers:[
      {provider:'feishu',supportedResources:['document','minutes','meeting'],appScopes:['docx:document:readonly','minutes:minutes.transcript:export','minutes:minutes.artifacts:read'],objectAcl:'per_resource',availability:'available',limitations:['provider_scope_and_resource_acl_required','unified_note_transcript_user_only','exact_meeting_instance_required','meeting_metadata_scopes_not_fully_verified']},
      {provider:'dingtalk',supportedResources:['document','meeting'],appScopes:['Storage.File.Read','VideoConference.Conference.Read','qyapi_get_member'],objectAcl:'per_resource',availability:'available',limitations:['verified_operator_required','meeting_transcript_only','ai_minutes_unsupported']},
      {provider:'wecom',supportedResources:[],appScopes:[],objectAcl:'per_resource',availability:'unknown',limitations:['wecom_application_resource_unverified']},
    ]};
    if(businessOAuth)registerBusinessOAuthRoutes(server,businessOAuth,{applicationOrigin:config.origin,applicationConfiguration,principal:request=>auth(request).id,context(request,assetId,runId){
      const row=store.one<{request_json:string;descriptor_json:string;task_id:string;workspace_id:string;entity_id:string}>('SELECT c.request_json,a.descriptor_json,g.task_id,g.workspace_id,g.entity_id FROM business_resource_run_context c JOIN message_assets a ON a.id=c.asset_id JOIN message_asset_run_grants g ON g.asset_id=c.asset_id AND g.run_id=c.run_id WHERE c.asset_id=? AND c.run_id=?',assetId,runId);
      if(!row)throw new TaskError(404,'business_resource_context_unavailable');entities.requireManager(auth(request).id,row.workspace_id,row.entity_id);
      const descriptor=JSON.parse(row.descriptor_json)as import('@dentity/application').SharedMessageAsset;if(!isBusinessResource(descriptor))throw new TaskError(403,'business_resource_context_unavailable');
      const context=JSON.parse(row.request_json)as ResourceAuthorizationRequest;if(context.run.taskId!==row.task_id||context.run.runId!==runId||context.run.workspaceId!==row.workspace_id||context.run.entityId!==row.entity_id)throw new TaskError(403,'business_resource_context_mismatch');
      employeeChannels.assertAssetSource(context.source);const resource=businessResource(descriptor);return{...context,resource,originResource:resource,operation:resource.kind==='document'?'content':'summary'};
    }});
    else server.get('/api/business-resources/configuration',(request,reply)=>{auth(request);reply.header('cache-control','no-store');return{configured:false,provider:'feishu',reason:'business_oauth_not_configured',application:applicationConfiguration};});
    server.get('/api/business-resources/materials',async(request,reply)=>{
      reply.header('cache-control','no-store');const query=request.query as Record<string,unknown>;if(typeof query.taskId!=='string'||!query.taskId||Object.keys(query).some(key=>key!=='taskId'))throw new TaskError(400,'business_resource_query_invalid');
      const task=store.one<{id:string;workspace_id:string;entity_id:string;run_id:string|null}>('SELECT id,workspace_id,entity_id,run_id FROM tasks WHERE id=?',query.taskId);if(!task)throw new TaskError(404,'task_not_found');entities.requireManager(auth(request).id,task.workspace_id,task.entity_id);
      const items=[];if(task.run_id){const rows=store.all<{asset_id:string;request_json:string;descriptor_json:string}>('SELECT c.asset_id,c.request_json,a.descriptor_json FROM business_resource_run_context c JOIN message_assets a ON a.id=c.asset_id JOIN message_asset_run_grants g ON g.asset_id=c.asset_id AND g.run_id=c.run_id WHERE c.run_id=? AND g.task_id=? AND g.workspace_id=? AND g.entity_id=?',task.run_id,task.id,task.workspace_id,task.entity_id);
        for(const row of rows){const descriptor=JSON.parse(row.descriptor_json)as import('@dentity/application').SharedMessageAsset,base=JSON.parse(row.request_json)as ResourceAuthorizationRequest,resource=businessResource(descriptor);
          const reads=store.all<{read_kind:string;state:string;reason:string|null}>('SELECT read_kind,state,reason FROM message_asset_versions WHERE asset_id=? ORDER BY read_kind',row.asset_id).map(read=>({kind:read.read_kind,state:read.state,...(read.reason?{reason:read.reason}:{})}));
          items.push({assetId:row.asset_id,kind:resource.kind,...(descriptor.name?{name:descriptor.name}:{}),provider:base.source.provider,accessMode:'application',reads,authorizationState:'not_checked'});
        }
      }return{taskId:task.id,runId:task.run_id,items};
    });
    const imageSource=(scope:import('@dentity/application').TaskScope)=>{const source=scope.source;return source&&['feishu','dingtalk','wecom'].includes(source.channelType)?{workspaceId:scope.workspaceId,entityId:scope.entityId,provider:source.channelType,tenantId:source.tenantId,applicationId:source.applicationId,connectionId:source.connectionId,bindingVersion:source.bindingVersion,chatId:source.conversationId,...(source.threadId?{threadId:source.threadId}:{})}:undefined;};
    hostRuntime?.setAssetService(assets);
    hostRuntime?.setGroupHistoryService(groupHistory);
    if(hostRuntime)server.addHook('preClose',()=>hostRuntime.drainMaterials());
    server.decorate('passiveRuntime',hostRuntime);
    store.db.exec('CREATE TABLE IF NOT EXISTS message_asset_task_selection(task_id TEXT PRIMARY KEY,ids_json TEXT NOT NULL)');
    const taskAuthorization=new ChannelTaskAuthorization(store,capabilities,employeeChannels,config.now,diagnostics,sharing);
    if(config.split?.assertNewAdmission){const resolve=taskAuthorization.resolveForTask.bind(taskAuthorization);taskAuthorization.resolveForTask=(scope,admission)=>{config.split!.assertNewAdmission!();return resolve(scope,admission);};}
    tasks = new TaskService(new SqliteTaskRepository(store), config.now, hostRuntime ?? config.runtime, taskAuthorization, new SqliteTaskRuntimeContextRetention(store), conversations, config.modelClient||config.modelClientForScope?undefined:scope=>{profiles.assertUsable(scope.workspaceId,scope.entityId);});
    const artifactRuntime=hostRuntime??config.runtime;
    const taskArtifacts=artifactRuntime?.artifacts&&artifactRuntime.artifactContent?new TaskArtifacts(store,tasks,{artifacts:artifactRuntime.artifacts.bind(artifactRuntime),artifactContent:artifactRuntime.artifactContent.bind(artifactRuntime)},(run,target)=>assets.assertBusinessOutputForRun(run,target)):undefined;
    tasks.setEventObserver(v=>diagnostics.event({stage:'runtime',phase:'point',traceId:v.taskId,messageId:v.eventId,taskId:v.taskId,runId:v.runId,...(v.sessionId?{sessionId:v.sessionId}:{}),operation:'runtime.events.commit',state:['waiting_human','needs_human','waiting_input','waiting_approval'].includes(v.status)?'waiting':v.status,outcome:'success',metrics:{sequence:v.sequence}}));
    server.post('/internal/runtime/group-history/:operation',async request=>{const op=(request.params as{operation:string}).operation;if(!['list','read'].includes(op))throw new TaskError(404,'not_found');const bearer=request.headers.authorization;if(!bearer?.startsWith('Bearer '))throw new TaskError(401,'history_unauthenticated');const access=groupHistory.authorize(bearer.slice(7),request.headers['x-dentity-host'],request.headers['x-dentity-run']);if(op==='list'){if(!request.body||Object.keys(request.body as object).length)throw new TaskError(400,'invalid_history_query');return groupHistory.list(access);}return groupHistory.read(access,request.body);});
    server.post('/internal/runtime/trigger-history/:operation',async request=>{if(!hostRuntime)throw new TaskError(503,'runtime_not_configured');const op=(request.params as{operation:string}).operation;if(!['list','read','contexts'].includes(op))throw new TaskError(404,'not_found');const bearer=request.headers.authorization;if(!bearer?.startsWith('Bearer '))throw new TaskError(401,'history_unauthenticated');const service=hostRuntime.triggerContext,auth=service.authorize(bearer.slice(7),request.headers['x-dentity-host'],request.headers['x-dentity-run']);if(op==='contexts'){if(!request.body||Object.keys(request.body as object).length)throw new TaskError(400,'invalid_history_query');return service.directory(auth);}return op==='list'?service.list(auth,request.body):service.read(auth,request.body);});
    const human=new HumanConfirmation(store,conversations,config.now);tasks.setHumanCoordinator(human);server.decorate('humanConfirmation',human);config.onHumanConfirmationService?.(human);
    workItems=new WorkItemsService(store,workItemConfiguration,capabilities,tasks,config.now,(w,e)=>{if(!hostRuntime&&!config.runtime)throw new TaskError(503,'runtime_not_configured');if(!config.modelClient&&!config.modelClientForScope)profiles.assertUsable(w,e);});server.decorate('workItems',workItems);config.onWorkItemService?.(workItems);taskAuthorization.setAssignments({authorize:s=>{workItems!.authorizeAssignment(s);},snapshot:s=>workItems!.assignmentSnapshot(s)});tasks.setWorkItemCoordinator(workItems);workItems.setMaterialPort(assets.workItemMaterials());workItems.setResourceValidator(run=>assets.revalidateBusinessResourcesForRun(run));if(config.split?.assertNewAdmission)workItems.setAdmissionGuard(config.split.assertNewAdmission);hostRuntime?.setWorkItemsService(workItems);if(hostRuntime)workItems.setLaunchGate(g=>hostRuntime!.applyWorkItemGate(g));
    if(artifactRuntime?.artifacts&&artifactRuntime.artifactContent){const bridge=new WorkItemArtifacts(store,{artifacts:artifactRuntime.artifacts.bind(artifactRuntime),artifactContent:artifactRuntime.artifactContent.bind(artifactRuntime)},config.now);workItems.setArtifacts(bridge);assets.setArtifactSource(bridge);}
    server.post('/internal/runtime/work-items/:operation',async request=>{const operation=(request.params as{operation:string}).operation;if(!['get_current','progress','handoff','finish','employees','reconcile'].includes(operation))throw new TaskError(404,'not_found');const bearer=request.headers.authorization;if(!bearer?.startsWith('Bearer '))throw new TaskError(401,'work_item_unauthenticated');const task=workItems!.authorize(bearer.slice(7),request.headers['x-dentity-host'],request.headers['x-dentity-run']);if(hostRuntime&&['handoff','finish'].includes(operation)&&Array.isArray((request.body as{artifactRefs?:unknown})?.artifactRefs)&&(request.body as{artifactRefs:unknown[]}).artifactRefs.length)await hostRuntime.refreshArtifacts(task.run_id!);return workItems!.executeAuthorized(task,operation as import('@dentity/contracts').WorkItemOperation,request.body);});
    tasks.setAssetPolicy({bind(scope:TaskRequestContext,taskId:string,runId:string|null,selected?:readonly string[]){
      const ids=selected??JSON.parse(store.one<{ids_json:string}>('SELECT ids_json FROM message_asset_task_selection WHERE task_id=?',taskId)?.ids_json??'[]') as string[];
      if(!ids.length)return;if(!scope.source)throw new TaskError(403,'asset_source_required');
      const source={requesterId:scope.principal?.externalUserId,requesterNamespace:scope.principal?.identityNamespace,workspaceId:scope.workspaceId,entityId:scope.entityId,provider:scope.source.channelType,tenantId:scope.source.tenantId,applicationId:scope.source.applicationId,connectionId:scope.source.connectionId,bindingVersion:scope.source.bindingVersion,chatId:scope.source.conversationId,conversationKind:scope.source.conversationKind,...(scope.source.threadId?{threadId:scope.source.threadId}:{})};
      if(runId)assets.grantForRun({workspaceId:scope.workspaceId,entityId:scope.entityId,taskId,runId},ids,source);
      else for(const id of ids)assets.assertForConversation(source,id);
      if(selected)store.run('INSERT INTO message_asset_task_selection VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET ids_json=excluded.ids_json',taskId,JSON.stringify(ids));
    }});
    const triggers=new TriggerService(store,tasks,capabilities,config.modelProfiles?.masterKey,config.now,notificationOptions);triggerService=triggers;config.onTriggerService?.(triggers);
    await registerTriggerRoutes(server,triggers,(r,w,e)=>{if(e)entities.requireManager(auth(r).id,w,e);else workspaces.get(auth(r).id,w);},{...config.triggers,...(config.split?{mode:'runtime' as const}:{})});
    const triggerTimer=config.triggers?.automatic===false?undefined:setInterval(()=>{if(!config.split?.assertNewAdmission||(()=>{try{config.split.assertNewAdmission();return true;}catch{return false;}})())void triggers.tick().catch(()=>{});},1000);triggerTimer?.unref();server.addHook('preClose',async()=>{if(triggerTimer)clearInterval(triggerTimer);await triggers.stop();});

    const registration = registerTasks(server, tasks, auth);
    registerAdminTasks(server,{store,auth,humanView:id=>human.view(id),requireAdmin:scope=>{if(!['owner','admin'].includes(workspaces.get(scope.userId,scope.workspaceId).role))throw new TaskError(403,'role_forbidden');}});
    server.get('/api/workspaces/:workspaceId/chat-employees',request=>{
      const user=auth(request),workspaceId=(request.params as {workspaceId:string}).workspaceId;
      return{entities:entities.list(user.id,workspaceId).filter(entity=>{try{tasks.authorize({userId:user.id,workspaceId,entityId:entity.id});return true;}catch(cause){if((cause instanceof TaskError||cause instanceof CapabilityConfigError)&&cause.status===403)return false;throw cause;}}).map(entity=>{let chatAvailable=true,chatBlockedReason:string|null=null;try{tasks.assertActive({userId:user.id,workspaceId,entityId:entity.id});profiles.assertUsable(workspaceId,entity.id);}catch(error){chatAvailable=false;chatBlockedReason=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'model_not_configured';}return{...entity,chatAvailable,chatBlockedReason};})};
    });
    const scheduleRepository=new SqliteScheduleRepository(store,'context.compact');
    let maintenance:ContextMaintenanceService|undefined;
    const authorizeConversationMaintenance=(conv:Conversation)=>{
      try {
        const scope=scopeFromJson(conv.scope_json,{workspaceId:conv.workspace_id,entityId:conv.entity_id,userId:conv.user_id});
        return !!scope.source && employeeChannels.currentBindingVersion(scope.source.connectionId)===scope.source.bindingVersion && !!store.one("SELECT e.id FROM entities e JOIN workspaces w ON w.id=e.workspace_id WHERE e.id=? AND e.workspace_id=? AND w.status='active' AND e.lifecycle_enabled=1",conv.entity_id,conv.workspace_id);
      }catch{return false;}
    };
    const groupContext=new SqliteGroupContext(store,(binding,event,ids)=>{if(binding.provider==='feishu')assets.allowTopicRootAssets(binding,event,ids);});
    employeeChannels.setCleanupListener(id=>groupContext.queueCleanup(id));
    server.addHook('preClose',()=>groupContext.close());
    let businessNotices:BusinessResultNotifications|undefined;
    const provider = createBuiltinInteractionProvider(store, conversations, tasks, config.now, entities, {
      human,workItems,...(taskArtifacts?{artifacts:taskArtifacts}:{}),
      async imageHistory(messages,scope){const source=imageSource(scope);return Promise.all(messages.map(async message=>{if(message.role!=='user'||!source){const{images:_,...plain}=message;return plain;}const refs=await assets.imageReferences(source,message.content);return{...message,images:refs};}));},
      inputImageAssets(c){const turn=conversations.turn(c.triggerId,c.conversation?.conversationId);if(!turn?.scope_json)return[];const scope=JSON.parse(turn.scope_json)as import('@dentity/application').TaskScope,source=imageSource(scope);return source?assets.authorizedImageIds(source,turn.text):[];},
      notificationContext:c=>businessNotices?.context(c),authorizeBusinessEvent:async(event,c)=>(await businessNotices?.authorize(event,c))===true,businessHistoryVisible:async(id,conversationId)=>(await businessNotices?.visible(id,conversationId))===true,
      authorizeHistoryBatch:(batchId,c)=>{const row=store.one<{guard_json:string}>('SELECT guard_json FROM group_live_batches WHERE id=?',batchId);if(!row)return false;const g=JSON.parse(row.guard_json),r=employeeChannels.repository.byId(g.connectionId);return !!r&&r.workspaceId===c.workspaceId&&r.entityId===c.entityId&&groupContext.commitAllowed(batchId,{connectionId:r.id,bindingVersion:employeeChannels.currentBindingVersion(r.id)??'',context:{...r.context,historyEnabled:false,meetingRefs:[]}});},
      historyBatchFallback:(batchId,c)=>{const row=store.one<{guard_json:string}>('SELECT guard_json FROM group_live_batches WHERE id=?',batchId);if(!row)return;const g=JSON.parse(row.guard_json),r=employeeChannels.repository.byId(g.connectionId);if(!r||r.workspaceId!==c.workspaceId||r.entityId!==c.entityId)return;return groupContext.fallback(batchId,{connectionId:r.id,bindingVersion:employeeChannels.currentBindingVersion(r.id)??''});},
      ...config,
      async assertTaskResources(task,scope){if(task.run_id)await assets.assertBusinessOutputForRun({workspaceId:task.workspace_id,entityId:task.entity_id,taskId:task.id,runId:task.run_id},{provider:scope.source?.channelType??'',connectionId:scope.source?.connectionId??'',tenantId:scope.source?.tenantId??'',chatId:scope.source?.conversationId??'',...(scope.source?.threadId?{threadId:scope.source.threadId}:{})});},
      async nativeMediaCapabilities(scope,target){const b=await employeeChannels.resolveBinding(target.connectionId);if(!b||b.workspaceId!==scope.workspaceId||b.entityId!==scope.entityId||b.provider!==target.provider||b.connection.tenantId!==target.tenantId)return;const caps=await b.conversation.inspectCapabilities(target);return target.conversationKind==='private'||target.conversationKind==='group'?caps.media?.outbound[target.conversationKind]:undefined;},
      diagnostics,
      journal,
      previousOwnerUnavailable:()=>runtimeOwner.previousOwnerUnavailable,
      assertRuntimeOwner:()=>runtimeOwner.assert(),
      readAdmittedInput:id=>store.one<{input_text:string}>('SELECT input_text FROM channel_inbox WHERE id=?',id)?.input_text??(()=>{throw new TaskError(404,'input_not_found');})(),
      authorizeConversationMaintenance,
      ...(!config.modelClient&&!config.modelClientForScope?{
        modelRevisionForMaintenance:(conv:Conversation)=>authorizeConversationMaintenance(conv)?profiles.revisionKey(conv.workspace_id,conv.entity_id):undefined,
        modelClientForMaintenance:async(conv:Conversation)=>{
          if(!authorizeConversationMaintenance(conv))throw new TaskError(403,'maintenance_binding_changed');
          const profile=profiles.effective(conv.workspace_id,conv.entity_id);
          if(!profile?.enabled||!profile.secretRef)throw new TaskError(409,'model_not_configured');
          return {revision:profiles.revisionKey(conv.workspace_id,conv.entity_id)!,client:new OpenAICompatibleModelClient({protocol:profile.protocol??'chat_completions',captureInvalidResponses:config.captureInvalidModelResponses===true,endpoint:profile.endpoint,model:profile.modelId,secretRef:profile.id,thinkingLevel:'none',allowLoopbackHttp:config.modelProfiles?.allowLoopbackHttp===true},async(ref,endpoint)=>{
            const secret=await profiles.resolve({workspaceId:conv.workspace_id,entityId:conv.entity_id,profileId:ref,configRevision:profile.configRevision,source:profile.source,...(profile.bindingRevision?{bindingRevision:profile.bindingRevision}:{}),purpose:'model-inference'},()=>authorizeConversationMaintenance(conv));
            if(secret.endpoint!==endpoint||!authorizeConversationMaintenance(conv))throw new TaskError(403,'maintenance_binding_changed');return secret.apiKey;
          },fetch,diagnostics)};
        },
      }:{}),
      authorizeMaintenance:request=>maintenance?.authorize(request)??false,
      ...(!config.modelClient && !config.modelClientForScope ? {modelRevisionForScope:scope=>{try{capabilities.assertActive(scope);}catch{return undefined;}const p=profiles.effective(scope.workspaceId,scope.entityId);return p?.enabled&&p.secretRef?profiles.revisionKey(scope.workspaceId,scope.entityId):undefined;},modelClientForScope: async scope => {
        tasks.assertActive(scope);tasks.authorizeLocal(scope);
        const profile = profiles.effective(scope.workspaceId, scope.entityId);
        if (!profile?.enabled || !profile.secretRef) throw new TaskError(409, 'model_not_configured');
        const modelRevision=profiles.revisionKey(scope.workspaceId,scope.entityId)!;
        const resolved = await profiles.resolve({workspaceId:scope.workspaceId,entityId:scope.entityId,profileId:profile.id,configRevision:profile.configRevision,source:profile.source,...(profile.bindingRevision?{bindingRevision:profile.bindingRevision}:{}),purpose:'model-inference'},()=>true);
        return {revision:modelRevision, client: new OpenAICompatibleModelClient({protocol:resolved.protocol??'chat_completions',imageInput:resolved.inputCapabilities?.image==='passed',readImage:async(ref,signal)=>{const source=imageSource(scope);if(!source)throw new TaskError(403,'asset_source_required');capabilities.assertActive(scope);return assets.imageContent(source,ref,signal);},captureInvalidResponses:config.captureInvalidModelResponses===true,endpoint:profile.endpoint,model:profile.modelId,secretRef:profile.id,thinkingLevel:'none',allowLoopbackHttp:config.modelProfiles?.allowLoopbackHttp===true},async (_ref,endpoint)=>{profiles.assertEnabledProfile(scope.workspaceId,profile.id);if(endpoint!==resolved.endpoint)throw new TaskError(403,'model_endpoint_changed');return resolved.apiKey;},fetch,diagnostics)};
      }} : {}),
    });
    human.setRecipientRouting({resolve:(w,e,target)=>resolveHumanTarget(employeeChannels,w,e,target),authorize:(w,e,target)=>authorizeHumanTarget(employeeChannels,capabilities,w,e,target),choose:createRecipientChoice(async scope=>{
      if(config.modelClientForScope){const r=await config.modelClientForScope(scope);return{...r,model:'configured-interaction-model'};}if(config.modelClient)return{client:config.modelClient,revision:'injected-v1',model:'injected-model'};
      const profile=profiles.effective(scope.workspaceId,scope.entityId);if(!profile?.enabled||!profile.secretRef)throw new TaskError(409,'model_not_configured');const revision=profiles.revisionKey(scope.workspaceId,scope.entityId)!;
      const resolved=await profiles.resolve({workspaceId:scope.workspaceId,entityId:scope.entityId,profileId:profile.id,configRevision:profile.configRevision,source:profile.source,...(profile.bindingRevision?{bindingRevision:profile.bindingRevision}:{}),purpose:'model-inference'},()=>true);
      return{model:profile.modelId,revision,client:new OpenAICompatibleModelClient({protocol:profile.protocol??'chat_completions',captureInvalidResponses:config.captureInvalidModelResponses===true,endpoint:profile.endpoint,model:profile.modelId,secretRef:profile.id,thinkingLevel:'none',allowLoopbackHttp:config.modelProfiles?.allowLoopbackHttp===true},async(_ref,endpoint)=>{profiles.assertEnabledProfile(scope.workspaceId,profile.id);if(endpoint!==resolved.endpoint)throw new TaskError(403,'model_endpoint_changed');return resolved.apiKey;},fetch,diagnostics)};
    },diagnostics)});
    const messageRepository=new SqliteMessageLoopRepository(store,config.now,diagnostics);
    const workItemNotices=new WorkItemNotifications(store,conversations,messageRepository,notificationCodec,tasks,config.now);workItems.setNotices(()=>workItemNotices.discover());
    const triggerResults=new TriggerResultNotifications(store,messageRepository,notificationCodec,(workspaceId,entityId)=>capabilities.assertActive({workspaceId,entityId}),taskId=>workItems!.isManaged(taskId));
    const notificationRepository=new SqliteTaskCompletionNotifications(store,conversations,messageRepository,diagnostics);
    let notifications:TaskCompletionNotifications;
    const interaction = diagnosticInteraction(createInteractionService(conversations, tasks, provider, config.now, {conversationTtlMs: ttl,humanAdmission:(scope,text)=>human.canReply(scope,text),
      visibleMessage:(scope,conversationId,id)=>notifications.visibleMessage(scope,conversationId,id),
      suppressDelivery:id=>notificationRepository.suppressDelivery(id),
      ...(!config.modelClient&&!config.modelClientForScope?{assertNewConversationModel:(scope:import('@dentity/application').TaskScope)=>{
        const profile=profiles.effective(scope.workspaceId,scope.entityId);
        if(!profile)throw new TaskError(409,profiles.hasCatalog(scope.workspaceId)?'model_selection_required':'model_not_configured');
        profiles.assertUsable(scope.workspaceId,scope.entityId);
      }}:{}),
    }),diagnostics);
    notifications=new TaskCompletionNotifications(notificationRepository,conversations,tasks,interaction,config.now,diagnostics);
    businessNotices=new BusinessResultNotifications(store,conversations,messageRepository,tasks,employeeChannels,journal,config.now,diagnostics);taskArtifacts&&businessNotices.setArtifacts(taskArtifacts);businessNotices.setResourceGuard(({targetJson,...run})=>assets.assertBusinessOutputTarget(run,targetJson));businessNotices.setGenerator((scope,conversationId,operationId,event)=>{return interaction.acceptBusinessEvent(scope,conversationId,operationId,event);});notificationRepository.setSink(v=>businessNotices!.enqueue(v));triggerResults.setSink(v=>businessNotices!.enqueue(v));workItemNotices.setSink(v=>businessNotices!.enqueue(v));const legacyNotificationTick=notifications.tick.bind(notifications),legacyNotificationStop=notifications.stop.bind(notifications);notifications.tick=async()=>{triggerResults.discover(config.now());workItemNotices.discover();await legacyNotificationTick();await businessNotices!.tick();};notifications.stop=async()=>{await Promise.all([legacyNotificationStop(),businessNotices!.stop()]);};
    config.onTaskCompletionNotifications?.(notifications);
    const continuation=(scope:import('@dentity/application').TaskScope)=>{try{if(!human.canReply(scope))tasks.authorize(scope);tasks.assertActive(scope);profiles.assertUsable(scope.workspaceId,scope.entityId);return{canSend:true,reason:null};}catch(error){return{canSend:false,reason:typeof error==='object'&&error!==null&&'code' in error?String(error.code):'runtime_unavailable'};}};
    const recentConversations=new RecentConversationReadService(new SqliteRecentConversationRead(store,conversations),tasks,(u,w)=>workspaces.get(u,w),(u,w,e)=>entities.requireReader(u,w,e),continuation,(s,c,m)=>notifications.visibleMessage(s,c,m),config.now);
    server.get('/api/workspaces/:workspaceId/recent-conversations',request=>recentConversations.list(auth(request).id,(request.params as {workspaceId:string}).workspaceId,request.query));
    server.get('/api/workspaces/:workspaceId/entities/:entityId/conversations/:conversationId',request=>{const p=request.params as {workspaceId:string;entityId:string;conversationId:string};const result=recentConversations.detail(auth(request).id,p.workspaceId,p.conversationId);tasks.conversation({userId:auth(request).id,workspaceId:p.workspaceId,entityId:p.entityId},p.conversationId);return result;});

    const humanChannels=new HumanChannelNotifications(store,employeeChannels,messageRepository,config.now,capabilities);human.setChannels(humanChannels);
    messageRepository.setTaskDeliveryPolicy({list:()=>notificationRepository.pendingChannelDeliveries(),
      async refresh(input){await taskArtifacts?.assertBusinessOutput(input);const row=taskArtifacts?.parentDelivery(input)??input;const notice=store.one<{task_id:string;run_id:string;workspace_id:string;entity_id:string}>('SELECT task_id,run_id,workspace_id,entity_id FROM business_notification_jobs WHERE id=?',row.id);let scoped:Record<string,unknown>={};try{scoped=JSON.parse(row.scopeJson);}catch{}const taskId=notice?.task_id??(typeof scoped.taskId==='string'?scoped.taskId:row.correlation?.taskId??notificationRepository.messageTask(row.id));if(taskId){const task=tasks.getRuntimeTask(taskId),runId=notice?.run_id??(typeof scoped.runId==='string'?scoped.runId:task.run_id);if(runId)await assets.assertBusinessOutputTarget({workspaceId:task.workspace_id,entityId:task.entity_id,taskId,runId},row.targetJson);}if(workItemNotices.isDelivery(row)){workItemNotices.assert(row);return;}if(humanChannels.isDelivery(row)){humanChannels.assert(row);return;}if(triggerResults.isDelivery(row)){triggerResults.assert(row);return;}const id=notificationRepository.messageTask(row.id);if(id){const task=tasks.getRuntimeTask(id);await tasks.refreshTaskContext(tasks.contextOfTask(task),id);}},
      assert(input){const row=taskArtifacts?.parentDelivery(input)??input;if(workItemNotices.isDelivery(row)){workItemNotices.assert(row);return;}if(humanChannels.isDelivery(row)){humanChannels.assert(row);return;}if(triggerResults.isDelivery(row)){triggerResults.assert(row);return;}const id=notificationRepository.messageTask(row.id);if(id)tasks.getRuntimeTask(id);},
    });
    maintenance=new ContextMaintenanceService(store,scheduleRepository,conversations,provider,config.now,config.maintenance);
    config.onMaintenanceService?.(maintenance);
    const whenConfigured=(work:()=>void)=>config.split?.whenConfigured?config.split.whenConfigured(work):work();
    whenConfigured(()=>interaction.recoverPreparing());
    const messageLoop=new ChannelMessageLoop(messageRepository,{
      ...(taskArtifacts?{queueAttachments:(base,conversationId,turnId,at)=>taskArtifacts.enqueue(messageRepository,base,conversationId,turnId,at),readAttachment:row=>taskArtifacts.readDelivery(row)}:{}),
      retainCommittedAssets:(conversationId,ids)=>{for(const id of ids)assets.retain(id,'history',conversationId);},
      allowHumanReply:(scope,text)=>human.canReply(scope,text),
      resolveBinding:async id=>{const b=await employeeChannels.resolveBinding(id);return b?{...b,assets}:undefined;},
      currentBindingVersion:id=>employeeChannels.currentBindingVersion(id),authorizeInvocation:async(b,a,k,s)=>{config.split?.assertNewAdmission?.();const live=await employeeChannels.resolveBinding(b.connectionId);if(!live||live.bindingVersion!==b.bindingVersion)throw new TaskError(403,'channel_binding_changed');return employeeChannels.authorizeInvocation(live,a,k,s);},
      describeActor:async(b,a)=>{const live=await employeeChannels.resolveBinding(b.connectionId);return live?employeeChannels.describeActor(live,a):{};},isVerificationEvent:(...args)=>employeeChannels.isVerificationEvent(...args),
    },interaction,tasks,config.now,diagnostics,groupContext);
    ingress=new ChannelIngressSupervisor(employeeChannels,messageLoop,config.channelIngressFactory??createSdkIngress,config.now,diagnostics,discoveredGroups,(binding,event,media)=>channelAssets.register(binding,event,media));
    // WeCom sends must use this owner's live SDK socket. Never lease its work on a standby.
    messageRepository.setClaimFilter(id=>employeeChannels.repository.byId(id)?.provider!=='wecom'||ingress?.canDispatch(id)===true);
    await ingress.start();
    config.onChannelIngressSupervisor?.(ingress);
    messageRepository.setRetentionReferenceGuard((kind,id)=>kind==='inbox'?!!store.one('SELECT 1 FROM interaction_turns WHERE queue_input_id=?',id):human.referencedDelivery(id));
    messageRepository.registerRetentionSweep('disk',diskObserver(store.databasePath,diagnostics));
    messageRepository.registerRetentionSweep('builtin',(at,limit)=>cleanupBuiltinTechnical(store,at,limit));
    messageRepository.registerRetentionSweep('platform-technical',technicalRetention(store));
    messageRepository.registerRetentionSweep('assets',(at,limit)=>assets.cleanup(at,limit));
    messageRepository.registerRetentionSweep('asset-cache',(at,limit)=>assets.cleanupCache(at,limit));
    server.addHook('onClose',()=>{channelAssets.close();assets.close();});
    messageRepository.cleanup(config.now());
    config.onChannelMessageLoop?.(messageLoop);
    server.get('/api/workspaces/:workspaceId/entities/:entityId/channels/:provider/message-status',request=>{const p=request.params as {workspaceId:string;entityId:string;provider:string};entities.requireReader(auth(request).id,p.workspaceId,p.entityId);const connection=employeeChannels.list(p.workspaceId,p.entityId).find(c=>c.provider===p.provider);if(!connection)throw new TaskError(404,'channel_connection_not_found');return messageRepository.health(connection.id);});
    registerInteractionRoutes(server, interaction, registration.scope, registration.base);
    if (hostRuntime) registerRuntimeResolver(server,hostRuntime,tasks,assets);
    registerLifecycle(server, config.split?.hasConfiguration?{tick:async()=>{if(config.split!.hasConfiguration!())await tasks.tick();},stop:()=>tasks.stop(),scrubExpiredContexts:()=>{if(config.split!.hasConfiguration!())tasks.scrubExpiredContexts();}}:tasks, interaction, () => {runtimeOwner.release();store.close();}, config.pollIntervalMs,{tick:async()=>{if(config.split?.hasConfiguration&&!config.split.hasConfiguration())return;triggerResults.discover(config.now());await notifications.tick();await Promise.all([maintenance!.tick(),messageLoop.tick()]);},stop:async()=>{await ingress!.stop();await Promise.all([notifications.stop(),maintenance!.stop(),messageLoop.stop()]);}});
    lifecycleRegistered = true;
    config.onService?.(tasks);
    whenConfigured(()=>groupContext.startCleanup(id=>employeeChannels.resolveBinding(id)));
    config.split?.runtimeReady?.({store,profiles,channels:employeeChannels,ingress,conversations,tasks,triggers,journal});
  } catch (error) {
    if (!lifecycleRegistered) {try{await ingress?.stop();await stopSnapshots?.();}finally{runtimeOwner.release();store.close();}}
    throw error;
  }
}
