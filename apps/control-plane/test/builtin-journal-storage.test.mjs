import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {Store,LegacyConversationStorageError} from '../dist/store.js';
import {createBuiltinStores} from '../dist/adapters/sqlite/builtin-stores.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'dentity-journal-storage-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function fixture(t){const dir=await directory(t),store=new Store(join(dir,'new.sqlite'));t.after(()=>store.close());const journal=new JsonlJournal({root:join(dir,'records'),ownerId:store.databaseId,serialize:fn=>store.transaction(fn)});const repository=new SqliteConversationRepository(store,journal,()=>100);repository.initialize(1000);store.db.exec("INSERT INTO users(id,username,display_name) VALUES('u','user','User');INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u');INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner');INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Entity','m','m',1,'u','builtin-interaction');");repository.create('c',{workspaceId:'w',entityId:'e',userId:'u'},'create',100,'real',1100);return{dir,store,journal,repository,conv:repository.get('c')};}

test('legacy body schemas fail preflight before changing bytes, schema, or journal mode',async t=>{
 const dir=await directory(t);
 for(const [i,schema] of ["CREATE TABLE builtin_records(key TEXT PRIMARY KEY,version INTEGER,json TEXT)","CREATE TABLE conversation_messages(id TEXT PRIMARY KEY,text TEXT)","CREATE TABLE interaction_turns(id TEXT PRIMARY KEY,request_json TEXT)","CREATE TABLE interaction_content(id TEXT PRIMARY KEY,text TEXT)","CREATE TABLE builtin_records(key TEXT PRIMARY KEY,version INTEGER,json TEXT); INSERT INTO builtin_records VALUES('old',1,'{\"messages\":[]}')"].entries()){
  const path=join(dir,`${i}.sqlite`),db=new DatabaseSync(path);db.exec(schema);const beforeSchema=db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();db.close();const before=await readFile(path);
  assert.throws(()=>new Store(path),LegacyConversationStorageError);assert.deepEqual(await readFile(path),before);const check=new DatabaseSync(path,{readOnly:true});assert.deepEqual(check.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(),beforeSchema);assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete');check.close();
 }
});

test('atomic CAS batches publish all or none and nested failures roll back',async t=>{
 const {store}=await fixture(t);const {sessionStore}=createBuiltinStores(store);
 assert.equal(await sessionStore.compareAndSetMany([{key:'a',expectedVersion:null,value:{ref:'a'}},{key:'b',expectedVersion:null,value:{ref:'b'}}]),true);
 assert.equal(await sessionStore.compareAndSetMany([{key:'a',expectedVersion:1,value:{ref:'changed'}},{key:'b',expectedVersion:9,value:{ref:'changed'}}]),false);assert.deepEqual(await sessionStore.get('a'),{version:1,value:{ref:'a'}});
 assert.throws(()=>store.transaction(()=>{store.run("UPDATE builtin_records SET version=99 WHERE key='a'");store.transaction(()=>{store.run("UPDATE builtin_records SET version=99 WHERE key='b'");throw Error('nested failure');});}),/nested failure/);assert.equal((await sessionStore.get('a')).version,1);assert.equal((await sessionStore.get('b')).version,1);
});

test('journal-written SQL rollback leaves invisible orphan records and permits safe retry',async t=>{
 const {store,repository,conv,dir}=await fixture(t);
 assert.throws(()=>repository.transaction(()=>{repository.addMessage('m',conv,'user','ORPHAN_PRIVATE_BODY',100,false);throw Error('synthetic SQL failure');}),/synthetic SQL failure/);
 assert.deepEqual(repository.messages('c',100),[]);assert.equal(store.one('SELECT count(*) AS n FROM conversation_message_index').n,0);
 const files=(await readdir(join(dir,'records'),{recursive:true})).filter(n=>n.endsWith('.jsonl'));assert.equal(files.length,1);assert.ok((await readFile(join(dir,'records',files[0]),'utf8')).includes('ORPHAN_PRIVATE_BODY'));
 repository.addMessage('m',conv,'user','ORPHAN_PRIVATE_BODY',100,false);assert.equal(repository.messages('c',100)[0].text,'ORPHAN_PRIVATE_BODY');assert.equal((await readFile(join(dir,'records',files[0]),'utf8')).trim().split('\n').length,1);
});

test('scoped SQL references cannot hydrate another conversation and expiry denies reads',async t=>{
 const {store,repository,conv}=await fixture(t);repository.addMessage('m',conv,'user','PRIVATE_SCOPED_BODY',100,false);const ref=store.one('SELECT record_ref FROM conversation_message_index').record_ref;
 repository.create('other',{workspaceId:'w',entityId:'e',userId:'u'},'other',100,'real',1100);store.run('INSERT INTO conversation_message_index(id,conversation_id,role,record_ref,created_at,simulated,expires_at) VALUES(?,?,?,?,?,?,?)','forged','other','user',ref,100,0,1100);assert.throws(()=>repository.messages('other',100),/scope or host mismatch/);
 assert.equal(repository.findHistoryMessage('m','c',1100),undefined);assert.equal(repository.getRetainedRealMessage('c','m',1100),undefined);assert.deepEqual(repository.messages('c',1100),[]);
});

test('database identity persists and rejects sharing a journal root with a second database',async t=>{
 const dir=await directory(t),path=join(dir,'one.sqlite'),store=new Store(path),id=store.databaseId;const root=join(dir,'records');new JsonlJournal({root,ownerId:id,serialize:fn=>store.transaction(fn)});store.close();const reopened=new Store(path);assert.equal(reopened.databaseId,id);reopened.close();const other=new Store(join(dir,'two.sqlite'));try{assert.throws(()=>new JsonlJournal({root,ownerId:other.databaseId,serialize:fn=>other.transaction(fn)}),/another database/);}finally{other.close();}
});


test('filesystem append failure cannot publish conversation references',async t=>{
 const {repository,conv,dir,store}=await fixture(t);const root=join(dir,'records');await rm(root,{recursive:true});await writeFile(root,'Synthetic blocked directory');
 assert.throws(()=>repository.addMessage('failed',conv,'user','UNPUBLISHED_PRIVATE_BODY',100,false),/trusted directories/);
 assert.equal(store.one('SELECT count(*) AS n FROM conversation_message_index').n,0);
 assert.throws(()=>repository.createTurn({id:'turn',conversation_id:'c',operation_id:'op',text:'UNPUBLISHED_PRIVATE_BODY',mode:'real',status:'preparing',request_json:null,output:null,error:null,created_at:100,epoch:1},false),/trusted directories/);
 assert.equal(store.one('SELECT count(*) AS n FROM interaction_turns').n,0);
});
