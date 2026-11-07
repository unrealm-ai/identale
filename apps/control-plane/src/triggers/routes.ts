import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {TriggerCommand} from '@dentity/application';
import {FixedWebhookAdapter} from './webhook.js';
import {TriggerService} from './service.js';
import {TriggerError,TRIGGER_BODY_LIMIT,verifyGithubSignature} from './protocol.js';
import {githubIssueEvent} from './github.js';
import {keyRule,periodKey,nextOccurrence,timezone} from './calendar.js';
const fail=(s:number,c:string):never=>{throw new TriggerError(s,c);};
export async function registerTriggerRoutes(app:FastifyInstance,service:TriggerService,member:(r:FastifyRequest,w:string,e:string)=>void,options:{allowLoopbackHttp?:boolean;mode?:'configuration'|'runtime'}={}){
  const base='/api/workspaces/:workspaceId/entities/:entityId';
  const route=(method:'GET'|'POST'|'PUT',path:string,work:(p:{workspaceId:string;entityId:string;triggerId?:string;keyId?:string},r:FastifyRequest)=>unknown)=>app.route({method,url:base+path,bodyLimit:128000,handler:async(request,reply)=>{const p=request.params as{workspaceId:string;entityId:string;triggerId?:string;keyId?:string};member(request,p.workspaceId,p.entityId);try{return await work(p,request);}catch(e){if(e instanceof TriggerError)return reply.code(e.status).send({error:e.code});throw e;}}});
  const binding=(w:string,e:string,id:string)=>{const b=service.repository.binding(id);if(!b||b.workspace_id!==w||b.entity_id!==e)return fail(404,'trigger_not_found');return b;};
  if(options.mode!=='runtime'){
  route('GET','/triggers',p=>service.list(p.workspaceId,p.entityId));
  route('POST','/triggers',(p,r)=>service.save(p.workspaceId,p.entityId,r.body));
  route('PUT','/triggers/:triggerId',(p,r)=>service.save(p.workspaceId,p.entityId,{...(r.body as object),id:p.triggerId}));
  route('PUT','/trigger-history-policy',(p,r)=>service.setPolicy(p.workspaceId,p.entityId,r.body));
  route('POST','/trigger-preview',(_p,r)=>{const b=r.body as{cron:unknown;timezone?:unknown;businessKey?:unknown};const zone=timezone(b?.timezone),at=nextOccurrence(b?.cron,zone,Date.now());return{timezone:zone,scheduledAt:at,...periodKey(keyRule(b?.businessKey??{mode:'empty'}),at,zone)};});
  app.post('/api/workspaces/:workspaceId/trigger-preview',r=>{const w=(r.params as{workspaceId:string}).workspaceId;member(r,w,'');const b=r.body as{cron:unknown;timezone?:unknown;businessKey?:unknown};const zone=timezone(b.timezone),at=nextOccurrence(b.cron,zone,Date.now());return{timezone:zone,scheduledAt:at,...periodKey(keyRule(b.businessKey??{mode:'empty'}),at,zone)};});
  route('POST','/triggers/:triggerId/credentials',(p,r)=>{binding(p.workspaceId,p.entityId,p.triggerId!);const b=r.body as{keyId:string;secret:string};if(!b||Object.keys(b).some(k=>!['keyId','secret'].includes(k)))return fail(400,'invalid_trigger_credential');return{credentials:service.repository.addCredential(p.workspaceId,p.triggerId!,b.keyId,b.secret)};});
  route('POST','/triggers/:triggerId/credentials/:keyId/revoke',p=>{binding(p.workspaceId,p.entityId,p.triggerId!);return{credentials:service.repository.revokeCredential(p.workspaceId,p.triggerId!,p.keyId!)};});
  }
  if(options.mode!=='configuration')route('GET','/triggers/:triggerId/events',p=>({events:service.events(p.workspaceId,p.entityId,p.triggerId!)}));
  if(options.mode==='configuration')return;
  await app.register(async ingress=>{
    ingress.removeContentTypeParser('application/json');ingress.addContentTypeParser('application/json',{parseAs:'buffer'},(_r,body,done)=>done(null,body));
    const generic=new FixedWebhookAdapter(service.repository,service);
    for(const kind of ['webhook','github'] as const)ingress.post(`/api/triggers/${kind}/:triggerId`,{bodyLimit:TRIGGER_BODY_LIMIT,config:{triggerWebhook:true,rateLimit:{max:120,timeWindow:'1 minute'}}},async(request,reply)=>{try{
      const triggerId=(request.params as{triggerId:string}).triggerId,body=request.body;
      if(!Buffer.isBuffer(body)||request.url!==`/api/triggers/${kind}/${triggerId}`)return fail(400,'invalid_trigger_route');
      const secure=request.protocol==='https'||options.allowLoopbackHttp===true&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip);if(!secure)return fail(400,'trigger_https_required');
      let receipt;
      if(kind==='webhook'){const headers=Object.fromEntries(Object.entries(request.headers).map(([k,v])=>[k,typeof v==='string'?v:undefined]));receipt=await generic.receive({triggerId,method:request.method,path:request.url,secure,headers,body,receivedAt:Date.now()});}
      else{const b=service.repository.binding(triggerId);if(!b||b.type!=='webhook')return fail(401,'trigger_authentication_failed');const c=JSON.parse(b.config_json);if(c.adapter!=='github_issue')return fail(401,'trigger_authentication_failed');let secret:string|undefined;for(const key of service.repository.credentials(b.workspace_id,b.id).filter(k=>k.status==='active')){try{const candidate=service.repository.secret(b.id,key.key_id);verifyGithubSignature(candidate,body,request.headers['x-hub-signature-256']);secret=candidate;break;}catch(e){if(!(e instanceof TriggerError)||e.status!==401)throw e;}}if(!secret)return fail(401,'trigger_authentication_failed');if(!b.enabled)return fail(403,'trigger_disabled');const event=githubIssueEvent({body,secret,signature:request.headers['x-hub-signature-256'],event:request.headers['x-github-event'],deliveryId:request.headers['x-github-delivery'],repositoryId:c.repositoryId,...(c.installationId!==undefined?{installationId:c.installationId}:{})});if(event.action!=='opened')return reply.code(204).send();
        const description='GitHub Issue #'+event.issueNumber+': '+event.title+'\n'+(event.body??'');if(description.length>8000)return fail(400,'trigger_description_too_large');
        // A delivery header is not MAC-covered. Opened is one stable signed issue fact.
        const command:TriggerCommand={version:1,eventId:`github-issue-opened-${event.repositoryId}-${event.issueId}`,action:'create_task',description,businessKey:JSON.stringify([event.repositoryId,event.issueNumber])};
        receipt=await service.accept({triggerId:b.id,sourceKind:'github_issue',sourceEvidenceRef:event.deliveryId,receivedAt:Date.now(),occurredAt:Date.now(),bodyHash:event.bodyHash,command});
      }
      return reply.code(receipt.duplicate?200:202).send(receipt);
    }catch(e){if(e instanceof TriggerError)return reply.code(e.status).send({error:e.code});return reply.code(503).send({error:'trigger_acceptance_unavailable'});}});
  });
}
