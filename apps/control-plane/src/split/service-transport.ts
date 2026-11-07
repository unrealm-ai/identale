import {timingSafeEqual} from 'node:crypto';
import {TaskError} from '@dentity/application';
/** Deployment capability, never accepted from browser identity headers. */
export function authorizeService(actual:unknown,token:string){
 const a=Buffer.from(typeof actual==='string'?actual:''),b=Buffer.from('Bearer '+token);
 if(a.length!==b.length||!timingSafeEqual(a,b))throw new TaskError(401,'service_unauthenticated');
}
export function serviceEndpoint(raw:string){const u=new URL(raw);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw new Error('Service endpoint must be an exact HTTPS or loopback origin');return u.origin;}
export function serviceToken(token:string){if(token.length<32||/[\r\n]/.test(token))throw new Error('Service credential must contain at least 32 safe characters');return token;}
export async function serviceJson(transport:typeof fetch,url:string,token:string,body?:unknown){
 const response=await transport(url,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok){const error=await response.json().catch(()=>null) as {error?:unknown}|null;throw new TaskError(response.status>=500?503:response.status,typeof error?.error==='string'&&/^[a-z0-9_]+$/.test(error.error)?error.error:'service_unavailable');}
 return response.json() as Promise<unknown>;
}
