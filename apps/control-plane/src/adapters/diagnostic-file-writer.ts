import {constants} from 'node:fs';
import {mkdir,lstat,readdir,unlink,open,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';

/** Single-owner batched sink. No business data or transport decisions live here. */
export class DiagnosticFileWriter {
 private fd:FileHandle|undefined;
 private active:string|undefined;
 private files:{name:string;size:number}[]=[];
 private scannedAt=-Infinity;
 private sequence=0;
 readonly stats={directoryScans:0,fileOpens:0,batchWrites:0};
 constructor(private readonly root:string,private readonly options:{now:()=>number;maxBytes:number;maxTotalBytes:number;retentionMs:number;beforeWrite?:()=>Promise<void>}){}
 private async closeFile(){const fd=this.fd;this.fd=undefined;this.active=undefined;await fd?.close();}
 private async scan(){
  await this.closeFile();await mkdir(this.root,{recursive:true,mode:0o700});
  const dir=await lstat(this.root);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||dir.uid!==process.getuid?.())throw Error('unsafe_log_directory');
  const names=(await readdir(this.root)).filter(n=>/^chain-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(n)).sort();this.files=[];
  for(const name of names){const info=await lstat(join(this.root,name));if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw Error('unsafe_log_file');
   if(this.options.now()-Date.parse(name.slice(6,16)+'T00:00:00Z')>=this.options.retentionMs)await unlink(join(this.root,name));else this.files.push({name,size:info.size});}
  this.scannedAt=this.options.now();this.stats.directoryScans++;
 }
 async append(lines:readonly string[]){
  if(!this.fd||this.options.now()-this.scannedAt>=60000)await this.scan();
  for(let offset=0;offset<lines.length;){
   const day=new Date(this.options.now()).toISOString().slice(0,10),last=this.files.filter(f=>f.name.startsWith('chain-'+day+'-')).at(-1);
   let file=last;const firstBytes=Buffer.byteLength(lines[offset]!);
   if(firstBytes>this.options.maxBytes||firstBytes>this.options.maxTotalBytes)throw Error('log_record_too_large');
   if(!file||file.size+firstBytes>this.options.maxBytes){await this.closeFile();this.sequence=last?Number(last.name.slice(17,23))+1:0;if(this.sequence>999999)throw Error('log_sequence_exhausted');file={name:`chain-${day}-${String(this.sequence).padStart(6,'0')}.jsonl`,size:0};this.files.push(file);}
   let bytes=0;const batch:string[]=[];
   while(offset<lines.length){const line=lines[offset]!,size=Buffer.byteLength(line);if(file.size+bytes+size>this.options.maxBytes||bytes+size>this.options.maxTotalBytes||batch.length&&bytes+size>256*1024)break;batch.push(line);bytes+=size;offset++;}
   if(!batch.length)throw Error('log_record_too_large');
   let total=this.files.reduce((n,f)=>n+f.size,0);
   while(total+bytes>this.options.maxTotalBytes){const oldest=this.files.find(f=>f!==file);if(!oldest){await this.closeFile();await unlink(join(this.root,file.name));total-=file.size;file.size=0;break;}if(oldest.name===this.active)await this.closeFile();await unlink(join(this.root,oldest.name));total-=oldest.size;this.files=this.files.filter(f=>f!==oldest);}
   if(this.active!==file.name){await this.closeFile();this.fd=await open(join(this.root,file.name),constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);const info=await this.fd.stat();if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw Error('unsafe_log_file');this.active=file.name;this.stats.fileOpens++;}
   const current=await this.fd!.stat();if(current.nlink!==1||(current.mode&0o077)!==0||current.uid!==process.getuid?.())throw Error('unsafe_log_file');
   await this.options.beforeWrite?.();await this.fd!.writeFile(batch.join(''));file.size+=bytes;this.stats.batchWrites++;
  }
 }
 async reset(){await this.closeFile();this.scannedAt=-Infinity;}
 async close(){await this.fd?.sync();await this.closeFile();}
}
