import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {crc32} from 'node:zlib';
import {mkdtemp,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,posix} from 'node:path';
import {fromBuffer,type Entry} from 'yauzl';
import {parseDocument} from 'yaml';
import {CapabilityConfigError} from './capability-config.js';
export interface SkillFile {path:string;data:string;size:number;digest:string}
export interface SkillPackage {name:string;description:string;content:string;files:SkillFile[];source?:{kind:'git';url:string;commit:string;subpath:string}|{kind:'zip'|'markdown'}}
export const skillLimits={packed:20*1024*1024,total:100*1024*1024,count:1000,file:20*1024*1024,document:65536};
const fail=(code:string):never=>{throw new CapabilityConfigError(400,code);};
export const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function safePath(value:string){if(!value||value.includes('\\')||/[\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||/^[a-z]:/i.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..')||value.length>512||value.split('/').length>20||value.split('/').some(p=>p.startsWith('.git')||p==='.env'||p.startsWith('.env.')))fail('unsafe_skill_path');return value;}
export function skillPackage(entries:{path:string;bytes:Buffer}[],stripRoot:boolean):SkillPackage{
 if(!entries.length||entries.length>skillLimits.count)fail('skill_package_limit');
 const roots=new Set(entries.map(e=>e.path.split('/')[0]));if(stripRoot&&(roots.size!==1||entries.some(e=>!e.path.includes('/'))))fail('skill_single_root_required');
 const seen=new Set<string>();let total=0;const files:SkillFile[]=[];
 for(const entry of entries){safePath(entry.path);let path=stripRoot?entry.path.slice(entry.path.indexOf('/')+1):entry.path;safePath(path);if(/^skill\.md$/i.test(path))path='SKILL.md';const key=path.normalize('NFC').toLowerCase();if(seen.has(key))fail('skill_duplicate_path');seen.add(key);total+=entry.bytes.length;if(total>skillLimits.total||entry.bytes.length>skillLimits.file)fail('skill_package_limit');files.push({path,data:entry.bytes.toString('base64'),size:entry.bytes.length,digest:sha(entry.bytes)});}
 for(const f of files)for(const other of files)if(other.path.toLowerCase().startsWith(f.path.toLowerCase()+'/'))fail('skill_duplicate_path');
 const main=files.find(f=>f.path==='SKILL.md');if(!main||main.size>skillLimits.document)return fail('skill_document_required');const bytes=Buffer.from(main.data,'base64'),content=bytes.toString('utf8');if(!Buffer.from(content).equals(bytes))fail('invalid_skill_encoding');
 const front=/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]+)$/.exec(content);if(!front||!front[2]!.trim())fail('skill_frontmatter_required');
 const parsed=parseDocument(front![1]!,{uniqueKeys:true});if(parsed.errors.length)fail('invalid_skill_frontmatter');let meta:Record<string,unknown>;try{meta=parsed.toJS({maxAliasCount:0}) as Record<string,unknown>;}catch{return fail('invalid_skill_frontmatter');}
 if(!meta||typeof meta!=='object'||Array.isArray(meta)||Object.keys(meta).some(k=>!['name','description','license','compatibility','metadata','allowed-tools'].includes(k))||typeof meta.name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name)||meta.name.length>64||typeof meta.description!=='string'||!meta.description.trim()||meta.description.length>1024)fail('invalid_skill_frontmatter');
 return{name:meta.name as string,description:meta.description as string,content,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
}
export async function zipSkill(bytes:Buffer):Promise<SkillPackage>{
 if(bytes.length>skillLimits.packed)fail('skill_package_limit');
 return new Promise((resolve,reject)=>fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>{if(error||!zip)return reject(new CapabilityConfigError(400,'invalid_skill_zip'));const entries:{path:string;bytes:Buffer}[]=[],roots=new Set<string>();let total=0,count=0,done=false;const bad=(error:unknown)=>{if(done)return;done=true;zip.close();reject(error instanceof CapabilityConfigError?error:new CapabilityConfigError(400,'invalid_skill_zip'));};
 zip.on('error',bad);zip.on('end',()=>{if(done)return;done=true;try{resolve(skillPackage(entries,true));}catch(error){reject(error);}});
 zip.on('entry',(e:Entry)=>{try{roots.add(e.fileName.split('/')[0]!);if(roots.size>1)fail('skill_single_root_required');if(++count>skillLimits.count+100||(e.generalPurposeBitFlag&1)!==0)fail('skill_package_limit');const mode=(e.externalFileAttributes>>>16)&0xf000;if(mode&&mode!==0x8000&&mode!==0x4000)fail('skill_link_forbidden');if(e.fileName.endsWith('/')){safePath(e.fileName.slice(0,-1));zip.readEntry();return;}safePath(e.fileName);if(e.uncompressedSize>skillLimits.file||total+e.uncompressedSize>skillLimits.total)fail('skill_package_limit');zip.openReadStream(e,(error,stream)=>{if(error||!stream)return bad(error);const chunks:Buffer[]=[];let length=0;stream.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>skillLimits.file||total+length>skillLimits.total){stream.destroy();bad(new CapabilityConfigError(400,'skill_package_limit'));}else chunks.push(chunk);});stream.on('error',bad);stream.on('end',()=>{if(done)return;const bytes=Buffer.concat(chunks);if(crc32(bytes)!==e.crc32)return bad(new CapabilityConfigError(400,'invalid_skill_zip'));total+=length;entries.push({path:e.fileName,bytes});zip.readEntry();});});}catch(error){bad(error);}});zip.readEntry();}));
}
async function diskSize(path:string):Promise<number>{let n=0;for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);n+=entry.isDirectory()?await diskSize(p):(await stat(p)).size;}return n;}
/** No checkout: repository filters/hooks and skill scripts are never evaluated. */
export async function gitSkill(input:{url:string;ref?:string;subpath?:string}):Promise<SkillPackage>{
 let url:URL;try{url=new URL(input.url);}catch{return fail('invalid_skill_git_url');}if(url.protocol!=='https:'||!['github.com','gitlab.com'].includes(url.hostname)||url.port||url.username||url.password||url.search||url.hash||!/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(url.pathname))fail('unsupported_skill_git_origin');
 const ref=input.ref??'HEAD',subpath=input.subpath??'';if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(ref)||ref.includes('..')||ref.includes('//'))fail('invalid_skill_git_ref');if(subpath)safePath(subpath);const directory=await mkdtemp(join(tmpdir(),'identity-skill-git-'));
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:directory,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_ALLOW_PROTOCOL:'https'};
 const deadline=Date.now()+90000;
 const run=(args:string[],limit=skillLimits.packed):Promise<Buffer>=>new Promise((resolve,reject)=>{if(Date.now()>=deadline)return reject(new CapabilityConfigError(400,'skill_git_import_timeout'));const child=spawn('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','http.followRedirects=false','-c','protocol.file.allow=never',...args],{cwd:directory,env,stdio:['ignore','pipe','pipe']});const chunks:Buffer[]=[];let length=0,finished=false;const timer=setTimeout(()=>child.kill('SIGKILL'),Math.min(60000,deadline-Date.now()));const check=setInterval(()=>{void diskSize(directory).then(n=>{if(n>200*1024*1024)child.kill('SIGKILL');}).catch(()=>{});},1000);child.stdout.on('data',(b:Buffer)=>{length+=b.length;if(length>limit)child.kill('SIGKILL');else chunks.push(b);});child.stderr.resume();child.on('error',()=>{clearTimeout(timer);clearInterval(check);finished=true;reject(new CapabilityConfigError(400,'skill_git_unavailable'));});child.on('close',code=>{clearTimeout(timer);clearInterval(check);if(finished)return;code===0&&length<=limit?resolve(Buffer.concat(chunks)):reject(new CapabilityConfigError(400,'skill_git_import_failed'));});});
 try{await run(['init','--bare','--template=']);await run(['fetch','--depth=1','--no-tags','--filter=blob:none','--',url.href,ref]);const commit=(await run(['rev-parse','--verify','FETCH_HEAD^{commit}'])).toString().trim();if(!/^[a-f0-9]{40,64}$/.test(commit))fail('skill_git_import_failed');
 const pack=await gitTreeSkill(run,commit,subpath);
 return{...pack,source:{kind:'git',url:url.href,commit,subpath}};
 }finally{await rm(directory,{recursive:true,force:true});}
}

/** Reads only regular blobs of a fixed tree, also used by isolated repository fixtures. */
export async function gitTreeSkill(run:(args:string[],limit?:number)=>Promise<Buffer>,commit:string,subpath:string):Promise<SkillPackage>{
 if(!/^[a-f0-9]{40,64}$/.test(commit))fail('invalid_skill_git_ref');if(subpath)safePath(subpath);
 const tree=(await run(['ls-tree','-r','-z',commit,...(subpath?['--',subpath]:[])])).toString('utf8').split('\0').filter(Boolean);if(tree.length>skillLimits.count)fail('skill_package_limit');const entries:{path:string;bytes:Buffer}[]=[];let total=0;
 for(const row of tree){const m=/^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);if(!m||!['100644','100755'].includes(m[1]!))fail('skill_git_special_file');const path=m![3]!,relative=subpath?posix.relative(subpath,path):path;safePath(relative);if(relative.startsWith('../'))fail('unsafe_skill_path');const data=await run(['cat-file','blob',m![2]!],skillLimits.file);total+=data.length;if(total>skillLimits.total)fail('skill_package_limit');entries.push({path:relative,bytes:data});}
 return skillPackage(entries,false);
}
