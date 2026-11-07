import type { TrustedResolver } from './types.js';
/** Configured service address only. Never follows redirects carrying the bearer credential. */
export function httpResolver(base: string, token: string,options:{fetch?:typeof fetch}={}): TrustedResolver {
  const url = new URL(base);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) throw new Error('Resolver must use HTTPS or loopback HTTP');
  if (!token) throw new Error('Resolver authentication required');
  const transport=options.fetch??fetch;
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await transport(`${base.replace(/\/$/, '')}/${path}`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Trusted resolver rejected request');
    return await response.json() as T;
  }
  return {
    assets:context=>post('assets',{ref:{},context}),
    asset:async(assetId,kind,context)=>{const response=await transport(`${base.replace(/\/$/,'')}/asset`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({ref:{assetId,kind},context}),signal:AbortSignal.timeout(30000)});if(response.status===401||response.status===403)return{state:'no_permission',reason:'asset_not_authorized'};if(response.status===404)return{state:'not_available',reason:'asset_unavailable'};if(response.status===429)return{state:'pending',reason:'asset_rate_limited'};if(response.headers.has('x-asset-sha256'))return response;const value=await response.json()as {state?:string;reason?:string};if(['pending','no_permission','not_available','failed'].includes(value.state??''))return value as Exclude<import('./asset-materializer.js').HostAssetResult,{state:'ready'}>;throw Error('Trusted asset resolver rejected request');},
    history:context=>post('history',{ref:{},context}),
    verify: async request => (await post<{ verified: boolean }>('verify', { request })).verified === true,
    content: async (ref, context) => (await post<{ text: string }>('content', { ref, context })).text,
    model: (ref, context) => post('model', { ref, context }),
    mcp:(ref,context)=>post('mcp',{ref,context}),
    modelAvailable:async context=>(await post<{available:boolean}>('model-status',{context,ref:{}})).available===true,
    storeOutput: async (text, context) => (await post<{ ref: Awaited<ReturnType<TrustedResolver['storeOutput']>> }>('output', { text, context })).ref,
  };
}
