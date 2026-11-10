import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {DatabaseSync} from 'node:sqlite';
import {taskDisplayTitle,taskTitleLength,timedTaskTitle} from '@dentity/contracts';
import {migrateTaskTitles} from '../dist/task-title-migration.js';
import {taskActivityFixture} from './helpers/task-activity-fixture.mjs';

test('bounded display handles whitespace, mixed text, graphemes and repeated local times',()=>{
 for(const input of ['长中文'.repeat(100),'a'.repeat(8000),'👨‍👩‍👧‍👦'.repeat(90),'é'.repeat(90)]){
  const title=taskDisplayTitle({input});assert.equal(taskTitleLength(title),60);assert.ok(title.endsWith('…'));assert.equal(input.includes('…'),false);
 }
 assert.equal(taskDisplayTitle({input:'  \n '}),'未命名任务');assert.equal(taskDisplayTitle({input:'full',title:' 标题\n清晰 '}),'标题 清晰');
 assert.equal(timedTaskTitle('日报',Date.parse('2026-11-05T07:57:00Z'),'Asia/Shanghai'),'日报 2611051557');
 assert.equal(timedTaskTitle('日报',Date.parse('2026-12-31T16:00:00Z'),'Asia/Shanghai'),'日报 2701010000');
 assert.equal(timedTaskTitle('报告',Date.parse('2026-11-01T05:30:00Z'),'America/New_York'),timedTaskTitle('报告',Date.parse('2026-11-01T06:30:00Z'),'America/New_York'),'display title is not an identity key even at DST fallback');
 assert.equal(taskTitleLength(timedTaskTitle('长'.repeat(120),Date.now(),'Asia/Shanghai')),60);
});
test('title migration is additive and repeatable, preserving legacy facts and rowids',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,input TEXT NOT NULL,request_hash TEXT NOT NULL); INSERT INTO tasks(rowid,id,input,request_hash) VALUES(42,'legacy','完整说明','old-hash');");migrateTaskTitles(db);migrateTaskTitles(db);const row=db.prepare('SELECT rowid,* FROM tasks').get();assert.deepEqual({...row},{rowid:42,id:'legacy',input:'完整说明',request_hash:'old-hash',title:null});}finally{db.close();}
});
test('task title HTTP creates, projections and permission boundaries use the existing authorized endpoints',async t=>{
 const f=await taskActivityFixture(t),root=`${f.entityBase}/conversations/${f.own.id}`;
 const body={operationId:'titled-http',input:'完整执行要求\n'+ '不得丢失'.repeat(100),title:'查看客户资料'};
 const create=await f.call('POST',root+'/todos',body,f.owner.cookie);assert.equal(create.statusCode,201,create.body);const task=create.json().task;assert.equal(task.title,body.title);assert.equal(task.input,body.input);
 for(const [path,read] of [[root+'/tasks',j=>j.tasks.find(x=>x.id===task.id)],[root+'/tasks/'+task.id,j=>j.task],[root+'/tasks/'+task.id+'/activity',j=>j.task],[f.base+'/task-management/task-list',j=>j.records.find(x=>x.id===task.id)],[f.base+'/task-management/task-list/'+task.id,j=>j],[f.base+'/task-management/task-list/'+task.id+'/activity',j=>j.task]]){
  const response=await f.call('GET',path,undefined,f.owner.cookie);assert.equal(response.statusCode,200,response.body);assert.equal(read(response.json()).title,body.title);assert.equal(read(response.json()).input,body.input);
 }
 assert.equal((await f.call('POST',root+'/todos',body,f.owner.cookie)).json().task.id,task.id);
 assert.equal((await f.call('POST',root+'/todos',{...body,title:'changed'},f.owner.cookie)).statusCode,409);
 assert.equal((await f.call('POST',root+'/todos',{...body,operationId:'invalid-title',title:'长'.repeat(61)},f.owner.cookie)).statusCode,400);
 for(const cookie of [f.member.cookie,f.outsider.cookie])assert.notEqual((await f.call('GET',root+'/tasks/'+task.id,undefined,cookie)).statusCode,200);
 assert.equal((await f.call('GET',f.base+'/task-management/task-list',undefined,f.member.cookie)).statusCode,403);assert.equal(f.modelCalls,0);
});

test('existing runtime split database upgrades title metadata on reopen without touching platform ownership',t=>{
 const root=mkdtempSync(join(tmpdir(),'task-title-split-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'runtime.sqlite');let store=new Store(path,{role:'runtime'});store.db.exec('DROP TABLE runtime_schema_migrations; ALTER TABLE main.tasks DROP COLUMN title');store.close();
 store=new Store(path,{role:'runtime'});assert.ok(store.all('PRAGMA main.table_info(tasks)').some(c=>c.name==='title'));store.close();
 const platform=new Store(join(root,'platform.sqlite'),{role:'platform'});try{assert.equal(platform.one("SELECT 1 FROM main.sqlite_master WHERE name='tasks'"),undefined);assert.ok(platform.all('PRAGMA temp.table_info(tasks)').some(c=>c.name==='title'));}finally{platform.close();}
});
