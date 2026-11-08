import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ResourceAuthorizationRequest} from './authorization.js';
import type {BusinessOAuthService} from './oauth.js';
export interface BusinessOAuthRouteHost{
 /** Trusted UI origin, which may differ from the registered callback origin. */
 applicationOrigin?:string;
 applicationConfiguration?:unknown;
 principal(request:FastifyRequest):string|Promise<string>;
 /** Must authorize task/asset access and load source/actor/resource/audience from persisted runtime provenance. Never from body. */
 context(request:FastifyRequest,assetId:string,runId:string):ResourceAuthorizationRequest|Promise<ResourceAuthorizationRequest>;
}
const selection=(value:unknown)=>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_selection');const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>k!=='assetId'&&k!=='runId')||typeof v['assetId']!=='string'||!v['assetId']||v['assetId'].length>200||typeof v['runId']!=='string'||!v['runId']||v['runId'].length>200)throw Error('invalid_selection');return{assetId:v['assetId'],runId:v['runId']};
};
export function registerBusinessOAuthRoutes(server:FastifyInstance,service:BusinessOAuthService,host:BusinessOAuthRouteHost){
 server.get('/api/business-resources/configuration',async(request,reply)=>{await host.principal(request);reply.header('cache-control','no-store');return {...service.configuration(),...(host.applicationConfiguration?{application:host.applicationConfiguration}:{})};});
 const path='/api/business-resources/feishu/authorize';
 server.get(path,async(request,reply)=>{
  await host.principal(request);reply.header('cache-control','no-store');
  try{const s=selection(request.query),context=await host.context(request,s.assetId,s.runId),token=await service.resolveForRequest(context);return token?{state:'authorized',expiresAt:token.expiresAt}:{state:'authorization_required'};}catch{return reply.code(403).send({error:'business_oauth_context_unavailable'});}
 });
 server.post(path,async(request,reply)=>{
  const principal=await host.principal(request);reply.header('cache-control','no-store');
  // Credentialed browser requests must originate at the configured application origin.
  if(request.headers.origin!==(host.applicationOrigin??new URL(service.configuration().redirectUri).origin))return reply.code(403).send({error:'business_oauth_origin_invalid'});
  try{const s=selection(request.body),context=await host.context(request,s.assetId,s.runId);return await service.begin(principal,context);}catch{return reply.code(403).send({error:'business_oauth_authorization_unavailable'});}
 });
 server.get('/api/business-resources/feishu/callback',{logLevel:'silent'},async(request,reply)=>{
  reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
  const principal=await host.principal(request),q=request.query as Record<string,unknown>;
  if(typeof q['state']!=='string'||typeof q['code']!=='string'||q['error']!==undefined)return reply.code(400).send({error:'business_oauth_callback_invalid'});
  try{return await service.complete(principal,q['state'],q['code']);}catch{return reply.code(403).send({error:'business_oauth_authorization_failed'});}
 });
}
