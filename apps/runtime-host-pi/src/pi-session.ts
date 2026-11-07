import {logProviderResponse} from './provider-response-log.js';
import{triggerHistoryTools}from'./trigger-history-tool.js';
import{workItemRuntime,workItemTaskRole}from'./work-item-tools.js';
import{groupHistoryTools}from'./group-history-tool.js';
import {humanRuntime} from './human-tool.js';
import { imageInputEnabled,resolvedThinkingLevel, type ThinkingLevel } from '@dentity/contracts';
import { mkdirSync, existsSync, readFileSync, writeFileSync,lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAgentSession, createExtensionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition, type Skill } from '@earendil-works/pi-coding-agent';
import { modelFetch } from './model-fetch.js';
import { connectMcpTools } from './mcp-tools.js';
import type { DriverInvocation } from './types.js';
import { createLocalTools } from './local-tools.js';
/** Resource IDs are code-reviewed registrations, never executable paths/commands from metadata. */
export const REGISTERED_PLATFORM_TOOLS = ['context.read','artifact.publish', 'progress.report','asset.read','human.ask','group.history','trigger.history','work.item'] as const;
export function registeredTools(input: DriverInvocation, reportProgress?: (text: string) => Promise<void>, beforeTool?: (name: string) => Promise<void>,readAsset?:(id:string,kind:'content'|'summary'|'transcript')=>Promise<import('./asset-materializer.js').HostAssetResult>,publishArtifact?:(path:string,operationId:string)=>Promise<unknown>): ToolDefinition[] {
  return input.spec.platformTools.filter(id=>id!=='human.ask'&&id!=='group.history'&&id!=='trigger.history'&&id!=='work.item').map(id => {
    if(id==='artifact.publish')return{executionMode:'sequential',name:'artifact_publish',label:'Publish artifact',description:'Publish an immutable output file from the current execution workspace as an authorized result candidate. A path in ordinary text does not publish or send a file.',parameters:{type:'object',properties:{path:{type:'string',minLength:1}},required:['path'],additionalProperties:false}as ToolDefinition['parameters'],execute:async(callId,args)=>{if(!publishArtifact||!args||typeof(args as {path?:unknown}).path!=='string'||Object.keys(args).some(k=>k!=='path'))throw Error('Invalid artifact publication');await beforeTool?.('artifact.publish');const result=await publishArtifact((args as {path:string}).path,callId);return{content:[{type:'text' as const,text:JSON.stringify(result)}],details:{}};}};
    if(id==='asset.read')return{executionMode:'sequential',name:'asset_read',label:'Read shared material',description:'Resolve an explicitly shared asset to an actual local file. Input asset_id from the available references and kind content/summary/transcript. Pending means not ready: do not loop rapidly. Images are not visual understanding.',parameters:{type:'object',properties:{asset_id:{type:'string'},kind:{type:'string',enum:['content','summary','transcript']}},required:['asset_id'],additionalProperties:false}as ToolDefinition['parameters'],execute:async(_callId,args)=>{const a=args as{asset_id?:unknown;kind?:unknown};if(typeof a.asset_id!=='string'||!input.assets?.some(r=>r.assetId===a.asset_id)||!readAsset||Object.keys(a).some(k=>!['asset_id','kind'].includes(k))||a.kind!==undefined&&!['content','summary','transcript'].includes(String(a.kind)))throw Error('Asset is not authorized');await beforeTool?.('asset.read');const result=await readAsset(a.asset_id,(a.kind??'content')as'content'|'summary'|'transcript');const output=result;return{content:[{type:'text' as const,text:JSON.stringify(output)}],details:{}};}};
    if (id === 'progress.report') return { executionMode: 'sequential', name: 'progress_report', label: 'Report progress', description: 'Record a concise internal task progress update. This does not send a message or notification to the user, and does not mark the task or business item complete.', parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['text'], additionalProperties: false } as ToolDefinition['parameters'], execute: async (_id, args) => { const text = (args as { text?: unknown }).text; if (typeof text !== 'string' || !text.length || text.length > 4096 || Object.keys(args as object).some(k => k !== 'text') || !reportProgress) throw new Error('Invalid progress report'); await beforeTool?.('progress.report'); await reportProgress(text); return { content: [{ type: 'text' as const, text: 'Progress recorded internally. This is not a user notification or completion receipt.' }], details: {} }; } };
    if (id !== 'context.read') throw new Error('Unregistered tool');
    return { executionMode: 'sequential', name: 'context_read', label: 'Read authorized context', description: 'Read the provided task requirements and reference materials. Takes no arguments.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } as ToolDefinition['parameters'],
      execute: async (_callId, args) => {
        if (args && Object.keys(args as object).length) throw new Error('No context selectors or identity overrides accepted');
        await beforeTool?.('context.read');
        return { content: [{ type: 'text' as const, text: input.prompt }], details: {} };
      } };
  });
}
export function resourceLoader(instructions: string, skills: Skill[] = []): ResourceLoader {
  return { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Dynamic resource discovery disabled'); }, reload: async () => {} };
}
/** Real official SDK initialization; exported to allow no-network conformance tests. */
export async function createPiSession(input: DriverInvocation, reportProgress?: (text: string) => Promise<void>, beforeTool?: (name: string) => Promise<void>, onMcpUnknown?: (name: string) => Promise<void>, beforeRequest?: (payload: Record<string, unknown>) => Promise<void>,readAsset?:(id:string,kind:'content'|'summary'|'transcript')=>Promise<import('./asset-materializer.js').HostAssetResult>,persistHuman?:(question:import('@dentity/contracts').HumanQuestion)=>Promise<void>,reportFailure?:(diagnostic:import('./model-diagnostics.js').ModelFailureDiagnostic)=>Promise<void>,reportLifecycle?:(diagnostic:import('./model-diagnostics.js').ModelFailureDiagnostic)=>Promise<void>,readHistory?:(operation:import('@dentity/contracts').ContextHistoryOperation,query:unknown)=>Promise<unknown>,workItemCall?:(operation:import('@dentity/contracts').WorkItemOperation,query:unknown)=>Promise<unknown>,publishArtifact?:(path:string,operationId:string)=>Promise<unknown>) {
  const workItemRole=input.spec.platformTools.includes('work.item')?workItemTaskRole(await workItemCall?.('get_current',{roleOnly:true})):undefined;
  const thinkingLevel=resolvedThinkingLevel(input.spec), nativeThinkingLevel=thinkingLevel==='none'?'off':thinkingLevel;
  const directory = resolve(input.sessionDirectory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Runtime override only. This backing store cannot load or persist account credentials.
  const credentials: NonNullable<Parameters<typeof ModelRuntime.create>[0]>['credentials'] = {
    read: async () => undefined, list: async () => [], modify: async () => { throw new Error('Credential persistence disabled'); }, delete: async () => {},
  };
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(directory, 'model-cache.json'), allowModelNetwork: false, refreshOnCreate: false });
  const profile = input.profile;
  if (profile.provider !== 'openai-compatible' || !profile.baseUrl || !profile.apiKey || !profile.modelId) throw new Error('Unsupported or unavailable model profile');
  const endpoint = new URL(profile.baseUrl); if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Invalid registered model endpoint');
  const protocol=profile.protocol??'chat_completions',api=protocol==='openai_responses'?'openai-responses':protocol==='anthropic_messages'?'anthropic-messages':'openai-completions';
  const modelBase=protocol==='anthropic_messages'?profile.baseUrl.replace(/\/$/,'').replace(/\/v1$/,''):profile.baseUrl;
  const providerId = 'dentity-registered-model';
  modelRuntime.registerProvider(providerId, { api, baseUrl:modelBase, authHeader:protocol!=='anthropic_messages',
    models: [{ id: profile.modelId, name: profile.modelId, api, reasoning: true, thinkingLevelMap: { off: 'none' }, ...(protocol==='chat_completions'?{compat:{supportsReasoningEffort:true,thinkingFormat:'openai' as const}}:{}), input: imageInputEnabled(profile.inputCapabilities)?['text','image']:['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }] });
  await modelRuntime.setRuntimeApiKey(providerId, profile.apiKey);
  const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
  let verifyThinking=()=>{};
  const guardedFetch = modelFetch(profile.baseUrl, profile.apiKey, thinkingLevel, async payload=>{verifyThinking();await beforeRequest?.(payload);},reportFailure,reportLifecycle,input.captureInvalidModelResponses?(raw,meta)=>logProviderResponse(input,raw,meta):undefined,protocol);
  modelRuntime.streamSimple = (selectedModel, context, options) => {
    // Fail before the SDK's HTTP layer can wrap a policy error as a generic connection failure.
    verifyThinking();
    return originalStream(selectedModel, context, { ...options, fetch: guardedFetch });
  };
  const model = modelRuntime.getModel(providerId, profile.modelId); if (!model) throw new Error('Registered model unavailable');
  const pointer = join(directory, 'session-pointer.json');
  let manager: SessionManager;
  if (input.resume) {
    if (!existsSync(pointer)) throw new Error('Persisted pi session is unavailable; refusing empty resume');
    const file: unknown = JSON.parse(readFileSync(pointer, 'utf8'));
    if (typeof file !== 'string' || !resolve(file).startsWith(`${directory}/`) || !existsSync(file)) throw new Error('Invalid pi session pointer');
    manager = SessionManager.open(file, directory, directory);
  } else {
    if (existsSync(pointer)) throw new Error('Fresh pi session already exists');
    manager = SessionManager.create(directory, directory);
    writeFileSync(pointer, JSON.stringify(manager.getSessionFile()), { mode: 0o600 });
  }
  const skills: Skill[] = input.skills.map(skill => { const baseDir=join(directory,'skills',skill.name),filePath=join(baseDir,'SKILL.md');const files=skill.files??[{path:'SKILL.md',data:Buffer.from(skill.content).toString('base64')}];for(const f of files){const path=join(baseDir,f.path);let parent=directory;for(const part of path.slice(directory.length+1).split('/').slice(0,-1)){parent=join(parent,part);if(existsSync(parent)){if(lstatSync(parent).isSymbolicLink()||!lstatSync(parent).isDirectory())throw new Error('Unsafe skill materialization');}else mkdirSync(parent,{mode:0o700});}if(existsSync(path)){if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||!readFileSync(path).equals(Buffer.from(f.data,'base64')))throw new Error('Skill materialization changed');}else writeFileSync(path,Buffer.from(f.data,'base64'),{mode:0o600,flag:'wx'});}return { name: skill.name, description: skill.description, filePath, baseDir, sourceInfo: { path: filePath, source: 'provided-skills', scope: 'temporary', origin: 'top-level' }, disableModelInvocation: true }; });
  const skillInstructions = input.skills.map(skill => `\n\nSkill ${skill.name} (files: ${join(directory,'skills',skill.name)}):\n${skill.content}`).join('');
  const mcp = await connectMcpTools(input.mcpServers, input.context, beforeTool, onMcpUnknown);
  const local = input.executionResource ? await createLocalTools(input.executionResource, beforeTool, onMcpUnknown) : { tools: [], close: async () => {} };
  const human=input.spec.platformTools.includes('human.ask')?humanRuntime(input.humanRequestId??(()=>{throw Error('human_request_identity_missing');})(),async q=>{if(!persistHuman)throw Error('human_request_persistence_missing');await persistHuman(q);},input.replanOnly):undefined;
  const workItems=input.spec.platformTools.includes('work.item')?workItemRuntime(workItemRole!,(op,args)=>workItemCall?.(op,args)??Promise.resolve({error:'work_item_unavailable'}),beforeTool):undefined;
  const allTools = [...(input.spec.platformTools.includes('trigger.history')&&readHistory?triggerHistoryTools(readHistory,beforeTool,!input.spec.platformTools.includes('group.history')):[]),...(workItems?.tools??[]),...(input.spec.platformTools.includes('group.history')&&readHistory?groupHistoryTools(readHistory,beforeTool):[]),...registeredTools(input, reportProgress, beforeTool,readAsset,publishArtifact), ...mcp.tools, ...local.tools,...(human?[human.tool]:[])];

  const customTools=input.replanOnly?allTools.filter(t=>['ask_human','context_read','asset_read','progress_report','read'].includes(t.name)||t.name.startsWith('work_item_')):allTools;
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0}});
  const instructions=input.instructions+skillInstructions+(workItems?'\n\nTrusted task role and business tools:\n'+workItems.instructions:'');
  let loader:ResourceLoader=resourceLoader(instructions,skills);
  if(human||workItems){const controlled=new DefaultResourceLoader({cwd:input.executionResource?.directory??directory,agentDir:directory,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:instructions,extensionFactories:[...(human?[human.extension]:[]),...(workItems?[workItems.extension]:[])]});await controlled.reload();controlled.getSkills=()=>({skills,diagnostics:[]});loader=controlled;}
  const result = await createAgentSession({ cwd: input.executionResource?.directory ?? directory, agentDir: directory, modelRuntime, model, thinkingLevel: nativeThinkingLevel,
    resourceLoader: loader, tools: customTools.map(t => t.name), noTools: 'builtin', customTools,
    sessionManager: manager, settingsManager:settings });
  verifyThinking=()=>assertPiThinkingLevel(thinkingLevel,result.session.thinkingLevel);
  try { verifyThinking(); } catch(error) { result.session.dispose(); await local.close(); await mcp.close(); throw error; }
  return { ...result, modelRuntime, manager, human, workItems,captureModelFailure:()=>guardedFetch.captureLatestFailure(), closeMcp: async () => { await local.close(); await mcp.close(); } };
}

/** SDK clamps and resumed/session overrides must never be reported as the requested level. */
export function assertPiThinkingLevel(requested:ThinkingLevel, actual:string):void {
  if(actual!==(requested==='none'?'off':requested))throw new Error('unsupported_thinking_level');
}
