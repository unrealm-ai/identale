import{createHash,randomUUID}from'node:crypto';
import{createReadStream}from'node:fs';
import{mkdir,lstat,realpath,open,rename,unlink}from'node:fs/promises';
import{join}from'node:path';
export type HostAssetResult={state:'ready';path:string;assetId:string;sha256:string;size:number;mediaType:string}|{state:'pending'|'no_permission'|'not_available'|'failed';reason?:string};
/** A trusted resolver streams bytes; a model never supplies URLs or paths. */
export async function materializeAsset(response:Response|Exclude<HostAssetResult,{state:'ready'}>,assetId:string,root:string):Promise<HostAssetResult>{
 if(!(response instanceof Response))return response;
 if(!/^[a-f0-9-]{36}$/.test(assetId)||response.headers.get('x-asset-id')!==assetId)throw Error('asset_identity_mismatch');
 if(!response.ok)throw Error('asset_resolver_failed');const hash=response.headers.get('x-asset-sha256'),size=Number(response.headers.get('content-length'));
 if(!hash||!/^([a-f0-9]{64})$/.test(hash)||response.headers.get('content-length')===null||!Number.isSafeInteger(size)||size<0)throw Error('asset_integrity_metadata_missing');
 await mkdir(root,{recursive:true,mode:0o700});const info=await lstat(root);if(info.isSymbolicLink()||!info.isDirectory()||(info.mode&0o077)!==0)throw Error('asset_materialization_root_unsafe');
 const canonical=await realpath(root),path=join(canonical,assetId+'-'+hash);
 try{const cached=await lstat(path);if(!cached.isFile()||cached.isSymbolicLink()||cached.nlink!==1||(cached.mode&0o077)!==0||cached.size!==size)throw Error('asset_cache_unsafe');const check=createHash('sha256');for await(const chunk of createReadStream(path))check.update(chunk);if(check.digest('hex')!==hash)throw Error('asset_cache_integrity_mismatch');await response.body?.cancel();return{state:'ready',path,assetId,sha256:hash,size,mediaType:response.headers.get('content-type')??'application/octet-stream'};}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
 const temp=join(canonical,randomUUID()+'.part'),file=await open(temp,'wx',0o600);const digest=createHash('sha256');let bytes=0,completed=false;
 try{const reader=response.body?.getReader();if(!reader)throw Error('asset_empty_stream');try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>size)throw Error('asset_size_mismatch');digest.update(part.value);await file.writeFile(part.value);}}finally{reader.releaseLock();}if(bytes!==size||digest.digest('hex')!==hash)throw Error('asset_integrity_mismatch');await file.sync();await file.close();await rename(temp,path);completed=true;return{state:'ready',path,assetId,sha256:hash,size,mediaType:response.headers.get('content-type')??'application/octet-stream'};
 }finally{if(!completed){await file.close().catch(()=>{});await unlink(temp).catch(()=>{});}}
}
