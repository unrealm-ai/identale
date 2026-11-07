import {constants,createReadStream}from'node:fs';
import{mkdir,lstat,realpath,open,rename,unlink,readFile,readdir}from'node:fs/promises';
import{join,basename,sep,resolve}from'node:path';
import{createHash,randomUUID}from'node:crypto';
import type {ArtifactRef}from'@dentity/contracts';

export interface PublishedArtifact extends ArtifactRef{readonly name:string;readonly mediaType:string;readonly size:number;readonly kind:'image'|'file'}
interface Record {runId:string;workspaceId:string;entityId:string;value:PublishedArtifact}
/** Explicit immutable publication, never a scan of all files in an Agent workspace. */
export class HostArtifacts{
 constructor(readonly root:string){}
 private async ready(){await mkdir(this.root,{recursive:true,mode:0o700});const s=await lstat(this.root);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw Error('artifact_store_unsafe');}
 async publish(scope:{runId:string;workspaceId:string;entityId:string},directory:string,path:string,operationId:string):Promise<PublishedArtifact>{
  await this.ready();if(!operationId||operationId.length>512)throw Error('invalid_artifact_operation');
  const operation=createHash('sha256').update(JSON.stringify([scope,operationId])).digest('hex'),recordPath=join(this.root,operation+'.json');
  const base=await realpath(directory),target=await realpath(resolve(directory,path));if(!target.startsWith(base+sep))throw Error('artifact_outside_execution_workspace');
  const original=await lstat(resolve(directory,path));if(original.isSymbolicLink()||!original.isFile()||original.nlink!==1)throw Error('artifact_source_unsafe');
  const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW),temp=join(this.root,randomUUID()+'.part');let published=false;
  try{
   const before=await file.stat();if(!before.isFile()||before.nlink!==1)throw Error('artifact_source_unsafe');
   const output=await open(temp,'wx',0o600),hash=createHash('sha256');let size=0,prefix=Buffer.alloc(0);
   try{for await(const chunk of file.createReadStream({autoClose:false})){const bytes=Buffer.from(chunk);if(prefix.length<16)prefix=Buffer.concat([prefix,bytes]).subarray(0,16);hash.update(bytes);size+=bytes.length;await output.writeFile(bytes);}await output.sync();}finally{await output.close();}
   const after=await file.stat(),current=await lstat(target),canonical=await realpath(target);if(!canonical.startsWith(base+sep)||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||after.nlink!==1||before.size!==size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('artifact_source_changed');
   const digest=hash.digest('hex'),name=basename(target).replace(/[\u0000-\u001f]/g,'_');
   const image=prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':prefix[0]===255&&prefix[1]===216?'image/jpeg':prefix.toString('ascii',0,3)==='GIF'?'image/gif':prefix.toString('ascii',0,4)==='RIFF'&&prefix.toString('ascii',8,12)==='WEBP'?'image/webp':undefined;
   const value:PublishedArtifact={content:{resourceId:'artifact:'+operation,version:digest},availability:'available',name,mediaType:image??'application/octet-stream',size,kind:image?'image':'file'};
   try{const prior=JSON.parse(await readFile(recordPath,'utf8'))as Record;if(JSON.stringify(prior)!==JSON.stringify({...scope,value}))throw Error('artifact_operation_conflict');return prior.value;}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
   await rename(temp,join(this.root,digest+'.blob'));published=true;
   const metaPath=recordPath+'.'+randomUUID()+'.part',record=await open(metaPath,'wx',0o600);try{await record.writeFile(JSON.stringify({...scope,value}));await record.sync();}finally{await record.close();}await rename(metaPath,recordPath);const parent=await open(this.root,'r');try{await parent.sync();}finally{await parent.close();}
   return value;
  }finally{await file.close();if(!published)await unlink(temp).catch(()=>{});}
 }
 async list(runId:string){await this.ready();const records:PublishedArtifact[]=[];for(const name of await readdir(this.root)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const row=JSON.parse(await readFile(join(this.root,name),'utf8'))as Record;if(row.runId===runId)records.push(row.value);}return records;}
 async read(runId:string,ref:{resourceId:string;version:string}){
  await this.ready();const id=ref.resourceId.replace(/^artifact:/,'');if(!/^[a-f0-9]{64}$/.test(id)||!/^artifact:/.test(ref.resourceId))throw Error('invalid_artifact_reference');const row=JSON.parse(await readFile(join(this.root,id+'.json'),'utf8'))as Record;
  if(row.runId!==runId||row.value.content.version!==ref.version)throw Error('artifact_not_granted');const path=join(this.root,ref.version+'.blob'),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)!==0||s.size!==row.value.size)throw Error('artifact_content_unsafe');
  const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);if(hash.digest('hex')!==ref.version)throw Error('artifact_integrity_mismatch');
  return{value:row.value,path};
 }
}
