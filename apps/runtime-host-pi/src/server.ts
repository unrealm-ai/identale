import{createReadStream}from'node:fs';
import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { MAX_RUNTIME_MATERIAL_BYTES, PROTOCOL_VERSION, healthResponseSchema, readinessResponseSchema } from '@dentity/contracts';
import type { PiRuntimeAdapter } from './adapter.js';
export interface ServerOptions { token?: string; monitorToken?: string; adapter?: PiRuntimeAdapter }
export const METHODS = ['capabilities','validateSpec','prepareAgent','inspectPreparedAgent','releaseAgent','createSession','resumeSession','closeSession','submit','getStatus','events','appendInput','cancel','getResult','executionRecords','readExecutionRecords'] as const;
function authorized(actual: string | undefined, token: string | undefined): boolean {
  if (!token || !actual) return false; const a = Buffer.from(actual); const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const payloadFields: Record<typeof METHODS[number], string[]> = { capabilities: ['runtime'], validateSpec: ['runtime','spec','policy'], prepareAgent: ['runtime','spec','policy','idempotencyKey'], inspectPreparedAgent: ['handle'], releaseAgent: ['handle'], createSession: ['handle','sessionId','contextBootstrap','idempotencyKey'], resumeSession: ['session'], closeSession: ['session'], submit: ['session','execution','input','idempotencyKey'], getStatus: ['execution'], events: ['execution','cursor'], appendInput: ['execution','inputId','input','idempotencyKey'], cancel: ['execution','reason'], getResult: ['execution'], executionRecords:['execution'],readExecutionRecords:['execution','query','viewer'] };
function validEnvelope(value: unknown, method: typeof METHODS[number]): boolean {
  if (!object(value) || value['schemaVersion'] !== 1 || !object(value['payload']) || !object(value['authorizationContext'])) return false;
  if (Object.keys(value).some(k => !['schemaVersion','operationId','correlationId','causationId','deadlineAt','authorizationContext','payload'].includes(k))) return false;
  if (!['operationId','correlationId','causationId','deadlineAt'].every(k => typeof value[k] === 'string' && value[k].length > 0)) return false;
  const payload = value['payload']; if (Object.keys(payload).some(k => !payloadFields[method].includes(k)) || payloadFields[method].some(k => k !== 'cursor' && !(k in payload))) return false;
  const spec = payload['spec']; if (spec !== undefined && (!object(spec) || Object.keys(spec).some(k => !['workspaceId','entityId','specVersion','specId','specHash','agentBindingId','role','thinkingLevel','sourceVersions','instructions','modelProfileRef','skills','mcpServers','cliRequirements','platformTools','executionResources','knowledgeScopes','contextPolicyRef','authorizationRef','limits','requiredCapabilities','optionalCapabilities'].includes(k)))) return false;
  const c = value['authorizationContext'];
  if (!['workspaceId','entityId','authorizationRef','expiresAt'].every(k => typeof c[k] === 'string' && c[k].length > 0)) return false;
  if (c['trigger'] !== undefined) {
    const trigger = c['trigger']; if (!object(trigger)) return false;
    if (trigger['kind'] === 'human_request') {
      const p = trigger['requester']; if (!object(p) || Object.keys(p).length !== 4 || !['channelType','tenantId','identityNamespace','externalUserId'].every(k => typeof p[k] === 'string' && p[k].length > 0)) return false;
    } else if(trigger['kind']==='work_item_assignment'){if(!['workItemId','assignmentId','grantRef'].every(k=>typeof trigger[k]==='string'&&trigger[k]))return false;}else if (trigger['kind'] !== 'configured_event' || typeof trigger['triggerBindingId'] !== 'string') return false;
  }
  return true;
}
/** Loopback transport only; exact shared DTOs, no alternate requester representation. */
export function createServer(options: ServerOptions = {}) {
  const server = Fastify({ logger: false, bodyLimit: 1_048_576 });
  server.get('/healthz', { schema: { response: { 200: healthResponseSchema } } }, () => ({ protocolVersion: PROTOCOL_VERSION, service: 'runtime-host-pi', status: 'alive', executionAvailable: !!options.token && !!options.adapter }));
  server.get('/readyz', { schema: { response: { 200: readinessResponseSchema, 503: readinessResponseSchema } } }, (_request, reply) => options.token && options.adapter ? { protocolVersion: PROTOCOL_VERSION, service: 'runtime-host-pi', status: 'ready', providerConnectivity: 'unverified' } : reply.code(503).send({ protocolVersion: PROTOCOL_VERSION, service: 'runtime-host-pi', status: 'not_ready', reason: 'runtime_not_configured' }));
  server.get('/internal/monitor/status', (request, reply) => {
    if (!options.monitorToken) return reply.code(503).send({ error: 'Monitoring unavailable' });
    if (!authorized(request.headers.authorization, options.monitorToken)) return reply.code(401).send({ error: 'Unauthorized' });
    if (!options.adapter) return reply.code(503).send({ error: 'Runtime unavailable' });
    return options.adapter.monitorStatus();
  });
  server.get<{ Params: { executionId: string } }>('/internal/monitor/executions/:executionId', (request, reply) => {
    if (!options.monitorToken) return reply.code(503).send({ error: 'Monitoring unavailable' });
    if (!authorized(request.headers.authorization, options.monitorToken)) return reply.code(401).send({ error: 'Unauthorized' });
    if (!options.adapter) return reply.code(503).send({ error: 'Runtime unavailable' });
    if (Object.keys(request.query as object).length || !request.params.executionId || request.params.executionId.length > 4096) return reply.code(400).send({ error: 'Invalid execution reference' });
    const metadata = options.adapter.monitorExecution(request.params.executionId);
    return metadata ?? reply.code(404).send({ error: 'Execution not found' });
  });
  server.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  server.get('/v2/materials/capabilities',(request,reply)=>{
    if(!authorized(request.headers.authorization,options.token))return reply.code(401).send({error:'Unauthorized'});
    return {version:1,mode:'passive',files:'sha256-cas',sdk:'initializes_on_submit'};
  });
  server.post('/v2/materials/:kind',{bodyLimit:1_048_576},async(request,reply)=>{
    if(!authorized(request.headers.authorization,options.token))return reply.code(401).send({error:'Unauthorized'});
    if(!options.adapter)return reply.code(503).send({error:'Runtime unavailable'});
    const kind=(request.params as {kind:string}).kind,m=options.adapter.materials;
    try{
      if(kind==='work-item-launch-gate')return options.adapter.applyWorkItemLaunchGate(request.body as import('@dentity/contracts').WorkItemLaunchGate);
      if(kind==='missing')return {missing:m.missing(request.body as import('@dentity/contracts').RuntimeBlobRef[])};
      if(kind==='configuration')return {...m.putConfiguration(request.body as import('@dentity/contracts').RuntimeConfigurationPackage),hostId:options.adapter.monitorStatus().hostId};
      if(kind==='run'){const packet=request.body as import('@dentity/contracts').RuntimeRunMaterials;if(packet.workItems&&packet.workItems.hostId!==options.adapter.monitorStatus().hostId)throw Error('work_item_host_mismatch');if(packet.triggerHistory&&packet.triggerHistory.hostId!==options.adapter.monitorStatus().hostId)throw Error('trigger_history_host_mismatch');if(packet.groupHistory&&packet.groupHistory.hostId!==options.adapter.monitorStatus().hostId)throw Error('history_host_mismatch');return m.putRun(packet);}
      if(kind==='inspect')return {...m.inspect((request.body as {configurationId:string}).configurationId),hostId:options.adapter.monitorStatus().hostId};
      if(kind==='record')return options.adapter.exportTriggerRecord((request.body as {request:Parameters<PiRuntimeAdapter['exportTriggerRecord']>[0]}).request);
      if(kind==='artifacts'){
        const b=request.body as {request:import('@dentity/contracts').RuntimeRequest<{execution:import('@dentity/contracts').ExecutionRef},import('@dentity/domain').RuntimeAuthorizationContext>};
        if(!await m.verify(b.request))return reply.code(403).send({error:'Forbidden'});
        return {artifacts:await options.adapter.artifacts.list(b.request.authorizationContext.authorizationRef)};
      }
      if(kind==='artifact'){
        const b=request.body as {request:import('@dentity/contracts').RuntimeRequest<{ref:import('@dentity/domain').ContentRef},import('@dentity/domain').RuntimeAuthorizationContext>};
        if(!await m.verify(b.request))return reply.code(403).send({error:'Forbidden'});
        const artifact=await options.adapter.artifacts.read(b.request.authorizationContext.authorizationRef,b.request.payload.ref);
        reply.header('content-type',artifact.value.mediaType).header('content-length',artifact.value.size).header('x-artifact-sha256',artifact.value.content.version).header('cache-control','no-store');return reply.send(createReadStream(artifact.path));
      }
      if(kind==='output'){
        const b=request.body as {request:import('@dentity/contracts').RuntimeRequest<{ref:import('@dentity/domain').ContentRef},import('@dentity/domain').RuntimeAuthorizationContext>};
        if(!await m.verify(b.request))return reply.code(403).send({error:'Forbidden'});
        return {text:m.readOutput(b.request.payload.ref,b.request.authorizationContext)};
      }
      return reply.code(404).send({error:'Not found'});
    }catch{return reply.code(409).send({error:'Materials unavailable or conflict'});}
  });
  server.put('/v2/materials/blobs/:digest',{bodyLimit:MAX_RUNTIME_MATERIAL_BYTES},(request,reply)=>{
    if(!authorized(request.headers.authorization,options.token))return reply.code(401).send({error:'Unauthorized'});
    if(!options.adapter)return reply.code(503).send({error:'Runtime unavailable'});
    try{if(!Buffer.isBuffer(request.body))return reply.code(400).send({error:'Binary body required'});options.adapter.materials.putBlob(request.body,(request.params as {digest:string}).digest);return {status:'stored'};}catch{return reply.code(409).send({error:'Invalid material'});}
  });
  for (const method of METHODS) server.post(`/v1/${method}`, async (request, reply) => {
    if (!options.token || !options.adapter) return reply.code(503).send({ error: 'Runtime unavailable' });
    if (!authorized(request.headers.authorization, options.token)) return reply.code(401).send({ error: 'Unauthorized' });
    if (!validEnvelope(request.body, method)) return reply.code(400).send({ error: 'Invalid runtime contract envelope' });
    // Payload-specific validation remains inside the adapter; accidental shape exceptions fail closed.
    try { const fn = options.adapter[method] as (request: unknown) => Promise<unknown>; return await fn.call(options.adapter, request.body); }
    catch { return reply.code(400).send({ error: 'Invalid runtime payload or unavailable configuration' }); }
  });
  return server;
}
