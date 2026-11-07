import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join,resolve,sep,dirname} from 'node:path';
const runRecordName=(runId:string)=>{if(typeof runId!=='string'||!runId||runId.length>200||/[\x00-\x1f]/.test(runId))throw Error('Invalid run reference');return createHash('sha256').update(runId).digest('hex')+'.jsonl';};
/** Host-owned native records only. No client paths and no SDK history conversion. */
export function nativeRecordFile(root:string,opaque:string,runId?:string,frozenRequired=false){
  if(runId){const frozen=join(realpathSync(root),'records',runRecordName(runId));if(existsSync(frozen)){const stat=lstatSync(frozen);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||realpathSync(frozen)!==resolve(frozen)||stat.size>32*1024*1024)throw Error('Unsafe frozen record');return{file:frozen,stat,frozen:true};}if(frozenRequired)return undefined;}
  if(!/^[a-zA-Z0-9_-]+$/.test(opaque))throw Error('Invalid session reference');
  const trusted=realpathSync(root),directory=join(trusted,'sessions',opaque),pointer=join(directory,'session-pointer.json');
  if(!existsSync(pointer))return undefined;
  for(const p of [join(trusted,'sessions'),directory,pointer])if(lstatSync(p).isSymbolicLink()||realpathSync(p)!==resolve(p)||!realpathSync(p).startsWith(trusted+sep))throw Error('Unsafe native record');
  const pointerStat=lstatSync(pointer);if(!pointerStat.isFile()||pointerStat.nlink!==1||pointerStat.size>16384)throw Error('Unsafe native pointer');
  const file:unknown=JSON.parse(readFileSync(pointer,'utf8'));if(typeof file!=='string'||realpathSync(dirname(file))!==directory)throw Error('Unsafe native pointer');
  const stat=lstatSync(file);if(stat.isSymbolicLink())throw Error('Unsafe native link');if(!stat.isFile()||stat.nlink!==1||realpathSync(file)!==join(directory,file.split(sep).at(-1)!)||stat.size>32*1024*1024)throw Error('Unsupported native record');
  return {file,stat,frozen:false};
}
export function nativeRecord(root:string,opaque:string,runId?:string,start=0,frozenRequired=false){
  const located=nativeRecordFile(root,opaque,runId,frozenRequired);if(!located)return undefined;
  const source=readFileSync(located.file),headerEnd=source.indexOf(10)+1;const bytes=!located.frozen&&start>headerEnd?Buffer.concat([source.subarray(0,headerEnd),source.subarray(start)]):source,first=JSON.parse(bytes.subarray(0,bytes.indexOf(10)).toString('utf8')) as{type?:string;version?:number};if(first.type!=='session'||!Number.isSafeInteger(first.version))throw Error('Unknown native format');
  return{bytes,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,format:'pi-session-jsonl',version:first.version!,committedCursor:String(bytes.length)};
}
export function materializeRecord(directory:string,key:string,bytes:Buffer){
  if(!/^[a-zA-Z0-9_-]+$/.test(key))throw Error('Invalid history key');const folder=join(directory,'trigger-history');
  mkdirSync(directory,{recursive:true,mode:0o700});if(existsSync(folder)&&lstatSync(folder).isSymbolicLink())throw Error('Unsafe history directory');mkdirSync(folder,{mode:0o700,recursive:true});
  const file=join(folder,key+'.jsonl');if(existsSync(file)){if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||!readFileSync(file).equals(bytes))throw Error('History copy changed');}else writeFileSync(file,bytes,{mode:0o400,flag:'wx'});
  if(realpathSync(dirname(file))!==realpathSync(folder))throw Error('Unsafe history path');return file;
}

/** A terminal segment is immutable even when its native Session later grows. */
export function freezeRunRecord(root:string,opaque:string,runId:string,start=0){
 const record=nativeRecord(root,opaque,undefined,start);if(!record)throw Error('Native checkpoint unavailable');
 const folder=join(realpathSync(root),'records');if(existsSync(folder)&&(lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==resolve(folder)))throw Error('Unsafe record directory');mkdirSync(folder,{recursive:true,mode:0o700});
 const file=join(folder,runRecordName(runId));if(existsSync(file)){if(lstatSync(file).isSymbolicLink()||!readFileSync(file).equals(record.bytes))throw Error('Frozen record changed');}else writeFileSync(file,record.bytes,{mode:0o400,flag:'wx'});
 return record;
}
