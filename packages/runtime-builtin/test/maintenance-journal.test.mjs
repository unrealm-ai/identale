import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, symlinkSync, writeFileSync, statSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JsonlJournal } from '../dist/index.js';
const scope={workspaceId:'w',entityId:'e',conversationId:'c'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'identity-maintenance-journal-'));const db=new DatabaseSync(join(dir,'test.sqlite'));db.exec('CREATE TABLE marker(id TEXT)');let depth=0;const options={root:join(dir,'records'),ownerId:'maintenance-test-db',serialize:fn=>{if(depth)return fn();db.exec('BEGIN IMMEDIATE');depth++;try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}finally{depth--;}}};const journal=new JsonlJournal(options);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return {dir,options,journal,path:join(options.root,journal.location(scope).resourceId)};}
const lines=path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
test('archive preserves source refs, retained suffix and messages appended after snapshot',t=>{const f=fixture(t);const old=f.journal.put(scope,'message',{role:'user',content:'older'});const recent=f.journal.put(scope,'message',{role:'assistant',content:'recent'});const snapshot=f.journal.capture(scope);const concurrent=f.journal.put(scope,'message',{role:'user',content:'during summary'});f.journal.archive(scope,'job-1',snapshot.recordIds,[recent.recordId]);assert.deepEqual(lines(join(f.path,'current.jsonl')).map(e=>e.id),[recent.recordId,concurrent.recordId]);assert.ok(lines(join(f.path,'raw','job-1.jsonl')).some(e=>e.id===old.recordId));const restarted=new JsonlJournal(f.options);assert.equal(restarted.read(scope,old).content,'older');assert.equal(restarted.read(scope,recent).content,'recent');assert.equal(restarted.read(scope,concurrent).content,'during summary');assert.deepEqual(restarted.location(scope),old.location);assert.equal(statSync(join(f.path,'current.jsonl')).mode&0o777,0o600);assert.equal(statSync(join(f.path,'raw','job-1.jsonl')).mode&0o777,0o600);});
test('archive retry after publication is idempotent and rejects a conflicting run identity',t=>{const f=fixture(t);const original=f.journal.put(scope,'text','raw');const capture=f.journal.capture(scope);f.journal.archive(scope,'job-id',capture.recordIds,[]);const archive=readFileSync(join(f.path,'raw','job-id.jsonl'),'utf8');const tail=f.journal.put(scope,'text','later');f.journal.archive(scope,'job-id',capture.recordIds,[]);assert.equal(readFileSync(join(f.path,'raw','job-id.jsonl'),'utf8'),archive);assert.equal(f.journal.read(scope,original),'raw');assert.equal(f.journal.read(scope,tail),'later');assert.throws(()=>f.journal.archive(scope,'job-id',[tail.recordId],[]),/another snapshot/);assert.throws(()=>f.journal.archive(scope,'../escape',capture.recordIds,[]),/run ID/);});
test('content-addressed retained records stay current even if also present in source snapshot',t=>{const f=fixture(t);const repeated=f.journal.put(scope,'message',{role:'user',content:'same'});const snapshot=f.journal.capture(scope);assert.deepEqual(f.journal.put(scope,'message',{role:'user',content:'same'}),repeated);f.journal.archive(scope,'repeat',snapshot.recordIds,[repeated.recordId]);assert.equal(lines(join(f.path,'current.jsonl')).length,1);assert.equal(f.journal.read(scope,repeated).content,'same');});
test('all sync fault boundaries retain every original record and recover by same-run retry',t=>{for(const failAt of [1,2,3,4,5]){const f=fixture(t);const old=f.journal.put(scope,'text','old');const tail=f.journal.put(scope,'text','tail');const snapshot=f.journal.capture(scope);let armed=false,count=0;const journal=new JsonlJournal({...f.options,beforeSync:()=>{if(armed&&++count===failAt)throw Error('injected durable publication fault');}});armed=true;assert.throws(()=>journal.archive(scope,`fault-${failAt}`,snapshot.recordIds,[tail.recordId]),/injected/);assert.equal(journal.read(scope,old),'old');assert.equal(journal.read(scope,tail),'tail');armed=false;const restarted=new JsonlJournal(f.options);restarted.archive(scope,`fault-${failAt}`,snapshot.recordIds,[tail.recordId]);assert.equal(restarted.read(scope,old),'old');assert.deepEqual(lines(join(f.path,'current.jsonl')).map(e=>e.id),[tail.recordId]);}});
test('one summary file is atomically replaced, checksummed, scoped and not searched as raw journal',t=>{const f=fixture(t);const initial=f.journal.writeSummary(scope,'v1',[{kind:'daily',date:'2026-10-22',text:'first'}]);assert.deepEqual(f.journal.readSummary(scope),initial);assert.throws(()=>f.journal.writeSummary(scope,'v1',[{text:'changed'}]),/different content/);const second=f.journal.writeSummary(scope,'v2',[{kind:'rollup',text:'older'},{kind:'daily',date:'2026-10-23',text:'new'}]);assert.deepEqual(new JsonlJournal(f.options).readSummary(scope),second);assert.equal(readdirSync(f.path).filter(p=>p==='summary.jsonl').length,1);assert.equal(f.journal.find(scope,'summary',()=>true),undefined);assert.equal(f.journal.readSummary({...scope,conversationId:'other'}),undefined);const path=join(f.path,'summary.jsonl');writeFileSync(path,readFileSync(path,'utf8').replace('older','tampered'));assert.throws(()=>f.journal.readSummary(scope),/checksum/);});
test('summary pre-fsync failure keeps previous effective summary',t=>{const f=fixture(t);const original=f.journal.writeSummary(scope,'v1',[{text:'original'}]);let armed=false;const j=new JsonlJournal({...f.options,beforeSync:kind=>{if(armed&&kind==='file')throw Error('summary sync failure');}});armed=true;assert.throws(()=>j.writeSummary(scope,'v2',[{text:'new'}]),/summary sync/);assert.deepEqual(j.readSummary(scope),original);});
test('archives reject symlinks and records remain available after lookup through legacy flat files',t=>{const f=fixture(t);const ref=f.journal.put(scope,'text','private');const current=join(f.path,'current.jsonl');const legacy=join(f.options.root,`${ref.location.resourceId}.jsonl`);writeFileSync(legacy,readFileSync(current));rmSync(current);assert.equal(f.journal.read(scope,ref),'private');const external=join(f.dir,'external');writeFileSync(external,'unchanged');symlinkSync(external,join(f.path,'evil.jsonl'));assert.throws(()=>f.journal.find(scope,'text',()=>true),/regular file/);assert.equal(readFileSync(external,'utf8'),'unchanged');});
test('batched writes and reads preserve order and duplicate occurrences across current and archive',t=>{const f=fixture(t);const refs=f.journal.putMany(scope,'message',[{text:'one'},{text:'two'},{text:'one'}]);assert.equal(refs.length,3);assert.equal(refs[0].recordId,refs[2].recordId);assert.equal(lines(join(f.path,'current.jsonl')).length,2);const capture=f.journal.capture(scope);f.journal.archive(scope,'batch',capture.recordIds,[refs[1].recordId]);const tail=f.journal.putMany(scope,'message',[{text:'three'},{text:'two'}]);const results=f.journal.readMany(scope,[tail[0],refs[0],refs[1],refs[2],tail[1]]);assert.deepEqual(results.map(x=>x.text),['three','one','two','one','two']);results[1].text='mutated';assert.equal(results[3].text,'one');assert.equal(f.journal.read(scope,refs[0]).text,'one');assert.throws(()=>f.journal.readMany(scope,[refs[0],{...refs[1],location:{...refs[1].location,hostId:'foreign'}}]),/scope or host/);assert.throws(()=>f.journal.readMany(scope,[refs[0],{...refs[1],recordId:'0'.repeat(64)}]),/unavailable/);assert.deepEqual(f.journal.putMany(scope,'message',[]),[]);assert.deepEqual(f.journal.readMany(scope,[]),[]);});
test('batched append syncs once per file and directory and safely retries a failed sync',t=>{const f=fixture(t);f.journal.put(scope,'message',{text:'seed'});let armed=false,fail=false;const observed=[];const j=new JsonlJournal({...f.options,beforeSync:kind=>{if(armed){observed.push(kind);if(fail&&kind==='file'){fail=false;throw Error('batch sync fault');}}}});armed=true;const refs=j.putMany(scope,'message',Array.from({length:100},(_,n)=>({text:`message-${n}`})));assert.equal(refs.length,100);assert.deepEqual(observed,['file','directory']);observed.length=0;fail=true;assert.throws(()=>j.putMany(scope,'message',[{text:'retry-1'},{text:'retry-2'}]),/batch sync fault/);observed.length=0;const retried=j.putMany(scope,'message',[{text:'retry-1'},{text:'retry-2'}]);assert.deepEqual(observed,['file','directory']);assert.deepEqual(new JsonlJournal(f.options).readMany(scope,retried),[{text:'retry-1'},{text:'retry-2'}]);assert.equal(lines(join(f.path,'current.jsonl')).length,103);});

const daily=(date,content='Exact daily facts.')=>({kind:'daily',date,fromDate:date,throughDate:date,content,sourceCheckpoint:'a'.repeat(64),sourceRecordCount:4});
test('daily archives preserve exact dated revisions and deduplicate retries across restart',t=>{
 const f=fixture(t),first=daily('2026-01-01');
 f.journal.archiveDailySummaries(scope,'job-1','UTC',[first]);
 const path=join(f.path,'history','2026-01-01.jsonl'),initial=readFileSync(path,'utf8');
 new JsonlJournal(f.options).archiveDailySummaries(scope,'job-2','UTC',[first]);
 assert.equal(readFileSync(path,'utf8'),initial);
 const revised={...first,content:'Late evidence included.',sourceCheckpoint:'b'.repeat(64)};
 f.journal.archiveDailySummaries(scope,'job-3','UTC',[revised,daily('2026-01-02')]);
 const rows=lines(path);assert.deepEqual(rows.map(r=>r.value.entry),[first,revised]);
 assert.deepEqual(rows.map(r=>r.value.maintenanceRunId),['job-1','job-3']);
 assert.equal(rows[0].value.timezone,'UTC');assert.notEqual(rows[0].value.revision,rows[1].value.revision);
 assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(join(f.path,'history')).mode&0o777,0o700);
 assert.deepEqual(readdirSync(join(f.path,'history')).sort(),['2026-01-01.jsonl','2026-01-02.jsonl']);
 assert.equal(f.journal.readSummary(scope),undefined);
});
test('history files are never enumerated or parsed by raw reference reads or find',t=>{
 const f=fixture(t),ref=f.journal.put(scope,'text','current raw');
 f.journal.archive(scope,'raw-job',f.journal.capture(scope).recordIds,[]);
 f.journal.archiveDailySummaries(scope,'daily-job','UTC',[daily('2026-01-01')]);
 writeFileSync(join(f.path,'history','2026-01-01.jsonl'),'intentionally invalid history');
 assert.equal(f.journal.read(scope,ref),'current raw');assert.equal(f.journal.find(scope,'text',()=>true),'current raw');
 assert.equal(f.journal.find(scope,'daily_summary_archive',()=>true),undefined);
});
test('mixed old and new raw layouts preserve refs and resume legacy archive runs in place',t=>{
 const f=fixture(t),old=f.journal.put(scope,'text','old'),snapshot=f.journal.capture(scope);
 f.journal.archive(scope,'old-job',snapshot.recordIds,[]);
 renameSync(join(f.path,'raw','old-job.jsonl'),join(f.path,'old-job.jsonl'));
 const fresh=f.journal.put(scope,'text','fresh');f.journal.archive(scope,'new-job',f.journal.capture(scope).recordIds,[]);
 const restarted=new JsonlJournal(f.options);restarted.archive(scope,'old-job',snapshot.recordIds,[]);
 assert.equal(existsSync(join(f.path,'raw','old-job.jsonl')),false);
 assert.deepEqual(restarted.readMany(scope,[fresh,old]),['fresh','old']);
 assert.ok(existsSync(join(f.path,'raw','new-job.jsonl')));
});
test('daily archive fault windows keep previous versions and recover idempotently',t=>{
 for(const failAt of [1,2,3]){
  const f=fixture(t),first=daily('2026-01-01');f.journal.archiveDailySummaries(scope,'first','UTC',[first]);
  let armed=false,count=0;const j=new JsonlJournal({...f.options,beforeSync:()=>{if(armed&&++count===failAt)throw Error('daily sync fault');}});
  const revised={...first,content:'A new revision.'};armed=true;
  assert.throws(()=>j.archiveDailySummaries(scope,'second','UTC',[revised]),/daily sync fault/);
  assert.deepEqual(lines(join(f.path,'history','2026-01-01.jsonl'))[0].value.entry,first);
  new JsonlJournal(f.options).archiveDailySummaries(scope,'second','UTC',[revised]);
  assert.deepEqual(lines(join(f.path,'history','2026-01-01.jsonl')).map(r=>r.value.entry),[first,revised]);
 }
});
test('daily archive validates dates and rejects corrupt, truncated and symbolic-link files',t=>{
 const f=fixture(t);for(const date of ['../escape','2026-02-30','2026-13-01'])assert.throws(()=>f.journal.archiveDailySummaries(scope,'job','UTC',[daily(date)]),/date/);
 f.journal.archiveDailySummaries(scope,'job','UTC',[daily('2026-01-01')]);
 const path=join(f.path,'history','2026-01-01.jsonl'),initial=readFileSync(path,'utf8');
 writeFileSync(path,initial.replace('Exact daily facts.','tampered'));
 assert.throws(()=>f.journal.archiveDailySummaries(scope,'retry','UTC',[daily('2026-01-01')]),/checksum/);
 writeFileSync(path,initial.slice(0,-1));assert.throws(()=>f.journal.archiveDailySummaries(scope,'retry','UTC',[daily('2026-01-01')]),/Incomplete/);
 writeFileSync(path,'');assert.throws(()=>f.journal.archiveDailySummaries(scope,'retry','UTC',[daily('2026-01-01')]),/Invalid daily/);
 rmSync(path);const outside=join(f.dir,'outside');writeFileSync(outside,'unchanged');symlinkSync(outside,path);
 assert.throws(()=>f.journal.archiveDailySummaries(scope,'retry','UTC',[daily('2026-01-01')]),/regular file/);
 assert.equal(readFileSync(outside,'utf8'),'unchanged');
});
test('raw and history directory symlinks are rejected without modifying their targets',t=>{
 for(const name of ['raw','history']){
  const f=fixture(t),ref=f.journal.put(scope,'text','retained'),outside=join(f.dir,'external');mkdirSync(outside);
  symlinkSync(outside,join(f.path,name));
  assert.throws(()=>name==='raw'?f.journal.archive(scope,'job',f.journal.capture(scope).recordIds,[]):f.journal.archiveDailySummaries(scope,'job','UTC',[daily('2026-01-01')]),/private directory/);
  assert.deepEqual(readdirSync(outside),[]);assert.ok(readFileSync(join(f.path,'current.jsonl'),'utf8').includes(ref.recordId));
  assert.throws(()=>f.journal.remove(scope),/private directory/);assert.ok(existsSync(join(f.path,'current.jsonl')));
 }
});
test('scope removal deletes both child directories and legacy files without touching other scopes',t=>{
 const f=fixture(t),ref=f.journal.put(scope,'text','raw');f.journal.archive(scope,'job',f.journal.capture(scope).recordIds,[]);
 f.journal.archiveDailySummaries(scope,'job','UTC',[daily('2026-01-01')]);f.journal.writeSummary(scope,'v1',[daily('2026-01-02')]);
 writeFileSync(join(f.path,'legacy.jsonl'),readFileSync(join(f.path,'raw','job.jsonl')));
 const other={...scope,conversationId:'other'},otherRef=f.journal.put(other,'text','keep');
 f.journal.remove(scope);assert.equal(existsSync(f.path),false);assert.equal(f.journal.read(other,otherRef),'keep');
 assert.equal(existsSync(join(f.options.root,ref.location.resourceId)),false);
});
