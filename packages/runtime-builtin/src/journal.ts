import { createHash, randomUUID } from 'node:crypto';
import { constants, chmodSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import type { SessionRecordLocation } from '@dentity/contracts';
import type {JournalIndexPort} from './journal-index.js';
import type { SummaryEntry } from './summary.js';

export interface JournalScope { readonly workspaceId:string; readonly entityId:string; readonly conversationId:string }
export interface JournalRef { readonly location:SessionRecordLocation; readonly recordId:string }
export interface JournalSnapshot { readonly recordIds: readonly string[] }
export interface JournalSummary { readonly version: string; readonly checksum: string; readonly entries: readonly unknown[] }
interface Entry { version:1; id:string; kind:string; value:unknown }
interface DailyArchive { date:string; timezone:string; revision:string; maintenanceRunId:string; entry:SummaryEntry }
function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
/** Runtime-owned local records. Production serialization MUST use the owning database's
 * synchronous write transaction. The manifest binds a root to exactly that database.
 * Caller authorization and SQL visibility are independent of possession of a file ref.
 */
export class JsonlJournal {
  readonly root:string;
  private readonly hostId:string;
  constructor(private readonly options:{root:string;ownerId:string;serialize:<T>(fn:()=>T)=>T;index?:JournalIndexPort;/** Deterministic test fault boundary; real filesystem operations are never replaced. */beforeSync?:(kind:'file'|'directory')=>void}) {
    if(!options.ownerId)throw new Error('Journal database owner is required');
    const requested=resolve(options.root);
    if(existsSync(requested)&&lstatSync(requested).isSymbolicLink())throw new Error('Journal root must not be a symbolic link');
    // Resolve existing platform aliases (e.g. macOS /var), but let directory()
    // create and sync each missing parent instead of an unsynced recursive mkdir.
    let parent=dirname(requested);const missing:string[]=[];
    while(!existsSync(parent)){missing.unshift(basename(parent));parent=dirname(parent);}
    this.root=join(realpathSync(parent),...missing,basename(requested));
    this.hostId=this.withLock(()=>{
      // The provisioner owns pre-existing ancestors. Only our root's directory
      // entry (including a constructor retry) needs its parent synced here.
      // In particular, a root-owned 0711 data container is traversal-only.
      this.directory();this.syncDirectory(dirname(this.root));chmodSync(this.root,0o700);
      const path=join(this.root,'owner.json');
      if(!existsSync(path)) {
        const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try {this.write(fd,JSON.stringify({version:1,ownerId:options.ownerId,hostId:randomUUID()}));this.syncFile(fd);}finally{closeSync(fd);}
        this.syncDirectory();
      }
      this.safeFile(path);
      const owner=JSON.parse(readFileSync(path,'utf8')) as {version:number;ownerId:string;hostId:string};
      if(owner.version!==1||owner.ownerId!==options.ownerId||typeof owner.hostId!=='string'||!owner.hostId)throw new Error('Journal root belongs to another database or has invalid ownership');
      const existing=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{this.syncFile(existing);}finally{closeSync(existing);}this.syncDirectory();
      return owner.hostId;
    });
  }
  withLock<T>(fn:()=>T):T{return this.options.serialize(fn);}
  private directory(){
    const parts=this.root.slice(parse(this.root).root.length).split('/').filter(Boolean);let current=parse(this.root).root;
    for(const part of parts){current=join(current,part);if(!existsSync(current)){mkdirSync(current,{mode:0o700});try{this.syncDirectory(dirname(current));}catch(error){try{rmdirSync(current);}catch{/* Preserve a concurrently populated directory. */}throw error;}}const s=lstatSync(current);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('Journal path must contain only trusted directories');}
  }
  private safeFile(path:string){const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1)throw new Error('Journal file is not a private regular file');}
  private syncFile(fd:number){this.options.beforeSync?.('file');fsyncSync(fd);}
  private syncDirectory(path=this.root){this.options.beforeSync?.('directory');const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
  private write(fd:number,text:string){const bytes=Buffer.from(text);let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)throw new Error('Journal write did not progress');offset+=n;}}
  location(scope:JournalScope):SessionRecordLocation {
    for(const value of Object.values(scope))if(typeof value!=='string'||!value)throw new Error('Invalid journal scope');
    return {storage:'local',hostId:this.hostId,resourceId:hash(scope),format:'dentity-builtin-jsonl',version:1};
  }
  private scopeDirectory(scope:JournalScope,location=this.location(scope)){
    if(canonical(this.location(scope))!==canonical(location))throw new Error('Journal reference scope or host mismatch');
    this.directory();const path=join(this.root,location.resourceId);
    if(!existsSync(path)){mkdirSync(path,{mode:0o700});this.syncDirectory();}
    const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Journal scope must be a private directory');
    chmodSync(path,0o700);return path;
  }
  private path(scope:JournalScope,location=this.location(scope)){return join(this.scopeDirectory(scope,location),'current.jsonl');}
  private subdirectory(scope:JournalScope,name:'raw'|'history'|'payloads',create:boolean):string|undefined {
    const parent=this.scopeDirectory(scope),path=join(parent,name);
    let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!stat){if(!create)return undefined;mkdirSync(path,{mode:0o700});stat=lstatSync(path);}
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Journal subdirectory must be a private directory');
    chmodSync(path,0o700);if(create)this.syncDirectory(parent);return path;
  }
  private archiveFiles(directory:string):string[] {
    const names=readdirSync(directory).filter(name=>name.endsWith('.jsonl')&&name!=='summary.jsonl'&&name!=='current.jsonl').sort();
    for(const name of names)if(!/^[A-Za-z0-9_-]+\.jsonl$/.test(name))throw new Error('Unexpected journal archive filename');
    return names.map(name=>join(directory,name));
  }
  private files(scope:JournalScope):string[]{
    const directory=this.scopeDirectory(scope),raw=this.subdirectory(scope,'raw',false);
    // Read old layouts as well as raw/. Never enumerate daily summary history.
    // Current is last so find() examines it first.
    const paths=[join(this.root,`${this.location(scope).resourceId}.jsonl`),...this.archiveFiles(directory),...(raw?this.archiveFiles(raw):[]),this.path(scope)];
    return paths.filter(path=>{try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}});
  }
  private readEntries(path:string,complete=false):Entry[]{this.safeFile(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const data=this.entries(fd);if(complete&&data.validBytes!==data.totalBytes)throw new Error('Incomplete daily summary archive');return data.entries;}finally{closeSync(fd);}}
  private atomicFile(path:string,text:string):void {
    if(existsSync(path))this.safeFile(path);
    const temporary=join(dirname(path),`.pending-${randomUUID()}`);const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{this.write(fd,text);this.syncFile(fd);}catch(error){closeSync(fd);try{unlinkSync(temporary);}catch{}throw error;}
    closeSync(fd);
    try{renameSync(temporary,path);this.syncDirectory(dirname(path));}catch(error){try{unlinkSync(temporary);}catch{}throw error;}
  }
  private entries(fd:number):{entries:Entry[];validBytes:number;totalBytes:number}{
    const size=fstatSync(fd).size,buffer=Buffer.alloc(size);let count=0;
    while(count<size){const n=readSync(fd,buffer,count,size-count,count);if(!n)throw new Error('Journal read interrupted');count+=n;}
    const end=buffer.lastIndexOf(10)+1;const entries:Entry[]=[];
    for(const line of buffer.subarray(0,end).toString('utf8').split('\n').filter(Boolean)){
      let e:Entry;try{e=JSON.parse(line) as Entry;}catch{throw new Error('Journal contains a corrupt committed line');}
      if(e.version!==1||typeof e.kind!=='string'||e.id!==hash([e.kind,e.value]))throw new Error('Journal checksum or version mismatch');
      entries.push(e);
    }
    return {entries,validBytes:end,totalBytes:size};
  }
  put(scope:JournalScope,kind:string,value:unknown):JournalRef {return this.putMany(scope,kind,[value])[0]!;}
  /** One scan and durable append for a batch. Returned references preserve every
   * input occurrence and order, including repeated content-addressed records. */
  putMany(scope:JournalScope,kind:string,values:readonly unknown[]):JournalRef[] {
    const entries:Entry[]=values.map(value=>({version:1,id:hash([kind,value]),kind,value:JSON.parse(canonical(value))}));
    return this.withLock(()=>{
      const location=this.location(scope);if(!entries.length)return [];
      if(this.options.index){this.ensureIndexed(scope);for(const entry of entries)this.storePayload(scope,entry);return entries.map(entry=>({location,recordId:entry.id}));}
      const path=this.path(scope,location);if(existsSync(path))this.safeFile(path);
      const fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
      try{
        if(!fstatSync(fd).isFile()||fstatSync(fd).nlink!==1)throw new Error('Invalid journal file');
        fchmodSync(fd,0o600);const data=this.entries(fd),known=new Set(data.entries.map(e=>e.id));
        const missing:Entry[]=[];for(const entry of entries)if(!known.has(entry.id)){missing.push(entry);known.add(entry.id);}
        // Only an incomplete, unpublished tail is removed under the DB write lock.
        if(data.validBytes!==data.totalBytes)ftruncateSync(fd,data.validBytes);
        const bytes=Buffer.from(missing.map(entry=>canonical(entry)+'\n').join(''));let offset=0;
        while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset,data.validBytes+offset);if(n<=0)throw new Error('Journal write did not progress');offset+=n;}
        this.syncFile(fd);
      }finally{closeSync(fd);}
      this.syncDirectory(dirname(path));
      return entries.map(entry=>({location,recordId:entry.id}));
    });
  }
  read<T>(scope:JournalScope,ref:JournalRef):T {return this.readMany<T>(scope,[ref])[0]!;}
  /** Validate all references before reading, then scan each required file at most
   * once. No mutable cache survives the database lock or a compaction publication. */
  readMany<T>(scope:JournalScope,refs:readonly JournalRef[]):T[] {
    return this.withLock(()=>{
      const location=canonical(this.location(scope));
      for(const ref of refs)if(canonical(ref.location)!==location)throw new Error('Journal reference scope or host mismatch');
      if(!refs.length)return [];
      if(this.options.index){this.ensureIndexed(scope);return refs.map(ref=>structuredClone(this.payload(scope,ref.recordId).value) as T);}
      const wanted=new Set(refs.map(ref=>ref.recordId)),values=new Map<string,unknown>();
      for(const path of this.files(scope).reverse()){
        for(const entry of this.readEntries(path))if(wanted.has(entry.id)&&!values.has(entry.id))values.set(entry.id,entry.value);
        if(values.size===wanted.size)break;
      }
      if(values.size!==wanted.size)throw new Error('Journal record is unavailable');
      return refs.map(ref=>structuredClone(values.get(ref.recordId)) as T);
    });
  }
  find<T>(scope:JournalScope,kind:string,predicate:(value:T)=>boolean):T|undefined {
    return this.withLock(()=>{
      if(this.options.index){this.ensureIndexed(scope);for(const record of this.options.index.list(this.location(scope).resourceId,kind)){const value=structuredClone(this.payload(scope,record.recordId).value) as T;if(predicate(value))return value;}return undefined;}
      for(const path of this.files(scope).reverse()){const values=this.readEntries(path).filter(e=>e.kind===kind);for(let i=values.length-1;i>=0;i--){const value=structuredClone(values[i]!.value) as T;if(predicate(value))return value;}}
      return undefined;
    });
  }
  private payloadPath(scope:JournalScope,id:string){if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid payload record ID');return join(this.subdirectory(scope,'payloads',false)??this.subdirectory(scope,'payloads',true)!,id+'.jsonl');}
  private storePayload(scope:JournalScope,entry:Entry){
    const index=this.options.index!,resource=this.location(scope).resourceId,path=this.payloadPath(scope,entry.id),text=canonical(entry)+'\n',bytes=Buffer.byteLength(text);
    if(existsSync(path)){const rows=this.readEntries(path,true);if(rows.length!==1||rows[0]!.id!==entry.id||canonical(rows[0])!==canonical(entry))throw Error('Immutable payload conflict');if(!index.get(resource,entry.id)){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{this.syncFile(fd);}finally{closeSync(fd);}this.syncDirectory(dirname(path));}}
    else this.atomicFile(path,text);
    const value=entry.value as {executionKey?:unknown;executionId?:unknown;execution?:{executionId?:unknown};runKey?:unknown;runId?:unknown}|null,executionKey=value?.executionKey??value?.executionId??value?.execution?.executionId,runKey=value?.runKey??value?.runId;
    index.add(resource,{recordId:entry.id,kind:entry.kind,bytes,...(typeof executionKey==='string'?{executionKey}:{}),...(typeof runKey==='string'?{runKey}:{})});
  }
  private payload(scope:JournalScope,id:string):Entry{
    const record=this.options.index!.get(this.location(scope).resourceId,id);if(!record)throw Error('Journal record is unavailable');
    const path=this.payloadPath(scope,id);this.safeFile(path);if(lstatSync(path).size!==record.bytes)throw Error('Payload size mismatch');const rows=this.readEntries(path,true);
    if(rows.length!==1||rows[0]!.id!==id||rows[0]!.kind!==record.kind)throw Error('Payload index mismatch');return rows[0]!;
  }
  private ensureIndexed(scope:JournalScope){
    const index=this.options.index!,resource=this.location(scope).resourceId;if(index.migrated(resource))return;
    // Fresh format only. Destructive test-history reset requires a separately
    // approved offline operation; never migrate, delete or replay old state here.
    if(this.files(scope).length)throw Error('interaction_storage_reset_required');
    index.markMigrated(resource);
  }
  /** Called inside the SAME transaction that publishes a Session head. File first,
   * SQL head second; rollback/crash can leave a projection ahead, never lost payload.
   * The next authoritative Session read rebuilds it without model/tool replay. */
  publishContext(scope:JournalScope,refs:readonly JournalRef[],version:string):void{
    if(!this.options.index)return;
    this.withLock(()=>{this.ensureIndexed(scope);const resource=this.location(scope).resourceId,old=this.options.index!.head(resource),path=this.path(scope);
      if(old?.version===version&&canonical(old.refs)===canonical(refs)&&existsSync(path)){this.safeFile(path);if(hash(readFileSync(path,'utf8'))===old.checksum)return;}
      for(const ref of refs)if(canonical(ref.location)!==canonical(this.location(scope)))throw Error('Context reference scope mismatch');
      const entries=refs.map(ref=>this.payload(scope,ref.recordId));if(entries.some(e=>e.kind!=='message'))throw Error('Current context must contain model messages');
      const text=entries.map(e=>canonical(e)+'\n').join(''),checksum=hash(text);
      if(existsSync(path))this.safeFile(path);
      if(!old||old.checksum!==checksum||!existsSync(path)||hash(readFileSync(path,'utf8'))!==checksum)this.atomicFile(path,text);
      this.options.index!.setHead(resource,{version,refs,checksum});
    });
  }
  /** Snapshot the current physical records, not a mutable array of live entries. */
  capture(scope:JournalScope):JournalSnapshot {return this.withLock(()=>{const path=this.path(scope);return {recordIds:existsSync(path)?this.readEntries(path).map(e=>e.id):[]};});}
  /** Move only snapshot records, never records appended after the snapshot. All raw
   * records are durable in the immutable archive BEFORE current is rewritten.
   * This is restart-idempotent; a runtime still publishes its own context head separately.
   */
  archive(scope:JournalScope,runId:string,sourceRecordIds:readonly string[],keepRecordIds:readonly string[]):void {
    this.withLock(()=>{
      if(!/^[A-Za-z0-9_-]{1,160}$/.test(runId)||['current','summary'].includes(runId))throw new Error('Invalid journal archive run ID');
      for(const id of [...sourceRecordIds,...keepRecordIds])if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid journal record ID');
      if(this.options.index){this.archiveContext(scope,runId,sourceRecordIds,keepRecordIds);return;}
      const directory=this.scopeDirectory(scope),path=this.path(scope),legacy=join(directory,`${runId}.jsonl`);
      // Resume an old-layout run in place; new runs use raw/ without migrating data.
      const target=existsSync(legacy)?legacy:join(this.subdirectory(scope,'raw',true)!,`${runId}.jsonl`);
      const source=new Set(sourceRecordIds),keep=new Set(keepRecordIds);
      const intent={runId,sourceRecordIds:[...source].sort()};
      let current=existsSync(path)?this.readEntries(path):[],archived:Entry[];
      if(existsSync(target)){
        archived=this.readEntries(target);const manifest=archived[0];
        if(manifest?.kind!=='archive_manifest'||canonical(manifest.value)!==canonical(intent))throw new Error('Archive run ID already belongs to another snapshot');
        const fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{this.syncFile(fd);}finally{closeSync(fd);}this.syncDirectory(dirname(target));
      } else {
        const selected=current.filter(e=>source.has(e.id)&&!keep.has(e.id));
        // A missing requested record is not a reason to silently drop raw source.
        const available=new Set(current.map(e=>e.id));
        for(const id of source)if(!available.has(id))throw new Error('Archive snapshot is unavailable');
        const manifest:Entry={version:1,id:hash(['archive_manifest',intent]),kind:'archive_manifest',value:intent};
        archived=[manifest,...selected];this.atomicFile(target,archived.map(e=>canonical(e)+'\n').join(''));
      }
      // The SQLite-backed lock remains held throughout archive + current publication.
      // New appends before this call are present; they are absent from source and retained.
      current=existsSync(path)?this.readEntries(path):[];
      const moved=new Set(archived.slice(1).map(e=>e.id));
      const retained=current.filter(e=>!moved.has(e.id)||keep.has(e.id));
      this.atomicFile(path,retained.map(e=>canonical(e)+'\n').join(''));
    });
  }
  private archiveContext(scope:JournalScope,runId:string,source:readonly string[],keep:readonly string[]){
    const path=this.path(scope),target=join(this.subdirectory(scope,'raw',true)!,runId+'.jsonl'),current=existsSync(path)?this.readEntries(path):[],ids=current.map(e=>e.id);
    const previous=existsSync(target)?this.readEntries(target,true):undefined,manifest=previous?.[0]?.value as {runId?:string;sourceRecordIds?:string[];retainedRecordIds?:string[]}|undefined;
    if(previous&&(previous[0]?.kind!=='archive_manifest'||manifest?.runId!==runId||canonical(manifest.sourceRecordIds)!==canonical(source)))throw Error('Archive run ID already belongs to another snapshot');
    const prefix=(a:readonly string[],b:readonly string[])=>a.length<=b.length&&a.every((v,i)=>v===b[i]);
    if(!prefix(source,ids)){if(manifest?.retainedRecordIds&&prefix(manifest.retainedRecordIds,ids))return;throw Error('Archive source context changed');}
    // Match kept OCCURRENCES from the end. Content-addressed IDs may appear more
    // than once; an old equal message must not erase or hide its retained tail.
    const kept=new Set<number>();let at=ids.length-1;
    for(let i=keep.length-1;i>=0;i--){while(at>=0&&ids[at]!==keep[i])at--;if(at<0)throw Error('Archive retained context changed');kept.add(at--);}
    const selected=current.filter((_,i)=>i<source.length&&!kept.has(i)),retained=current.filter((_,i)=>i>=source.length||kept.has(i));
    if(previous){if(canonical(previous.slice(1))!==canonical(selected))throw Error('Archive snapshot changed');const fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{this.syncFile(fd);}finally{closeSync(fd);}this.syncDirectory(dirname(target));}
    else{const intent={runId,sourceRecordIds:[...source],retainedRecordIds:retained.map(e=>e.id)},entry:Entry={version:1,id:hash(['archive_manifest',intent]),kind:'archive_manifest',value:intent};this.atomicFile(target,[entry,...selected].map(e=>canonical(e)+'\n').join(''));}
    this.atomicFile(path,retained.map(e=>canonical(e)+'\n').join(''));
  }
  /** Preserve exact daily rows consumed by a historical rollup. A date file holds
   * immutable, checksummed revisions; retries deduplicate by content and provenance.
   * These files are not raw journal records and are never searched by read/find.
   */
  archiveDailySummaries(scope:JournalScope,runId:string,timezone:string,entries:readonly SummaryEntry[]):void {
    if(!entries.length)return;
    this.withLock(()=>{
      if(!/^[A-Za-z0-9_-]{1,160}$/.test(runId))throw new Error('Invalid daily archive run ID');
      new Intl.DateTimeFormat('en',{timeZone:timezone}).format(0);
      for(const entry of entries){
        const date=entry.date;
        if(entry.kind!=='daily'||!date||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||entry.fromDate!==date||entry.throughDate!==date)throw new Error('Invalid daily archive date');
      }
      const directory=this.subdirectory(scope,'history',true)!;
      for(const entry of entries){
        const date=entry.date!,path=join(directory,`${date}.jsonl`),revision=hash([timezone,entry]);
        const present=existsSync(path),rows=present?this.readEntries(path,true):[];
        if(present&&!rows.length)throw new Error('Invalid daily summary archive');
        for(const row of rows){const value=row.value as DailyArchive;if(row.kind!=='daily_summary_archive'||value.date!==date||value.revision!==hash([value.timezone,value.entry]))throw new Error('Invalid daily summary archive');}
        if(!rows.some(row=>(row.value as DailyArchive).revision===revision)){
          const value:DailyArchive={date,timezone,revision,maintenanceRunId:runId,entry:JSON.parse(canonical(entry)) as SummaryEntry};
          rows.push({version:1,id:hash(['daily_summary_archive',value]),kind:'daily_summary_archive',value});
          this.atomicFile(path,rows.map(row=>canonical(row)+'\n').join(''));
        }else{
          // A previous rename may have succeeded before its directory sync failed.
          const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{this.syncFile(fd);}finally{closeSync(fd);}this.syncDirectory(directory);
        }
      }
    });
  }
  /** One effective bounded summary file. The caller validates its generation against
   * its committed context head and can reconstruct it from its recovery checkpoint.
   */
  writeSummary(scope:JournalScope,version:string,entries:readonly unknown[]):JournalSummary {
    return this.withLock(()=>{
      if(!version||version.length>200)throw new Error('Invalid summary version');
      const detached=JSON.parse(canonical(entries)) as unknown[],checksum=hash([version,detached]);
      let previous:JournalSummary|undefined;
      try{previous=this.readSummary(scope);}catch{ /* A committed runtime checkpoint may repair a corrupt projection. */ }
      if(previous?.version===version&&previous.checksum!==checksum)throw new Error('Summary version already has different content');
      const rows=[{kind:'summary_manifest',formatVersion:1,version,checksum},...detached.map(value=>({kind:'summary',value}))];
      this.atomicFile(join(this.scopeDirectory(scope),'summary.jsonl'),rows.map(row=>canonical(row)+'\n').join(''));
      return {version,checksum,entries:detached};
    });
  }
  readSummary(scope:JournalScope):JournalSummary|undefined {
    return this.withLock(()=>{
      const path=join(this.scopeDirectory(scope),'summary.jsonl');if(!existsSync(path))return undefined;this.safeFile(path);
      const text=readFileSync(path,'utf8');if(!text.endsWith('\n'))throw new Error('Incomplete summary file');
      const rows=text.trimEnd().split('\n').map(line=>JSON.parse(line) as {kind:string;formatVersion?:number;version?:string;checksum?:string;value?:unknown});
      const manifest=rows.shift();if(manifest?.kind!=='summary_manifest'||manifest.formatVersion!==1||typeof manifest.version!=='string'||typeof manifest.checksum!=='string'||rows.some(row=>row.kind!=='summary'))throw new Error('Invalid summary file');
      const entries=rows.map(row=>row.value);if(hash([manifest.version,entries])!==manifest.checksum)throw new Error('Summary checksum mismatch');
      return {version:manifest.version,checksum:manifest.checksum,entries};
    });
  }
  /** Only explicit retention/revocation callers may remove a whole scope. Compaction
   * never calls this: it preserves archives for source retrieval. */
  remove(scope:JournalScope):void {this.withLock(()=>{
    const directory=this.scopeDirectory(scope),files=new Set(this.files(scope)),children:string[]=[];
    for(const name of readdirSync(directory)){
      if(name==='raw'||name==='history'||name==='payloads'){
        const child=this.subdirectory(scope,name,false)!;children.push(child);
        for(const entry of readdirSync(child))files.add(join(child,entry));
      }else files.add(join(directory,name));
    }
    // Validate the entire scope before deleting anything. Never follow symlinks or
    // recursively remove unexpected directories outside the two owned children.
    for(const path of files)this.safeFile(path);
    for(const path of files)unlinkSync(path);
    this.options.index?.remove(this.location(scope).resourceId);
    for(const child of children){this.syncDirectory(child);rmdirSync(child);}
    this.syncDirectory(directory);rmdirSync(directory);this.syncDirectory();
  });}
}
