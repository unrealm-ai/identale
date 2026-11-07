import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {SqliteScheduleRepository} from '../dist/adapters/sqlite/schedule-repository.js';
import {Scheduler} from '@dentity/application';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'identity-schedule-')),path=join(dir,'db.sqlite');const store=new Store(path);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return{store,path,repository:new SqliteScheduleRepository(store)};}
test('durable scheduler deduplicates intent, rejects key reuse, and survives process recreation',async t=>{
 const {repository,store}=await fixture(t);let calls=0,now=100;const handlers={maintenance:async()=>{calls++;return{status:'succeeded'};}};
 const first=new Scheduler(repository,handlers,()=>now);const a=first.enqueue('one','maintenance',{session:'private-A'}),b=first.enqueue('one','maintenance',{session:'private-A'});assert.equal(a.id,b.id);assert.throws(()=>first.enqueue('one','maintenance',{session:'private-B'}),/intent/);assert.throws(()=>first.enqueue('bad','unknown',{}),/Unsupported/);
 const resumed=new Scheduler(new SqliteScheduleRepository(store),handlers,()=>now);await resumed.tick();await resumed.tick();assert.equal(calls,1);assert.equal(repository.get(a.id).status,'succeeded');await first.stop();await resumed.stop();
});
test('expired worker cannot commit after lease takeover',async t=>{
 const {repository}=await fixture(t);const queued=repository.enqueue('one','maintenance',{},0),first=repository.claim(1,10);assert.equal(first.id,queued.id);assert.equal(repository.owns(first.id,first.leaseToken,5),true);assert.equal(repository.claim(5,10),undefined);
 const second=repository.claim(12,10);assert.equal(second.id,first.id);assert.notEqual(second.leaseToken,first.leaseToken);assert.equal(repository.owns(first.id,first.leaseToken,12),false);assert.equal(repository.settle(first.id,first.leaseToken,'succeeded',0,null,13),false);assert.equal(repository.settle(second.id,second.leaseToken,'succeeded',0,null,13),true);assert.equal(repository.get(first.id).attempt,2);
});
test('scheduler bounds failure retries and serializes overlapping ticks',async t=>{
 const {repository}=await fixture(t);let now=100,calls=0,release;const barrier=new Promise(r=>release=r);const scheduler=new Scheduler(repository,{maintenance:async()=>{calls++;await barrier;throw Error('Synthetic failure');}},()=>now,{maxAttempts:2});const job=scheduler.enqueue('retry','maintenance',{});
 const a=scheduler.tick(),b=scheduler.tick();assert.equal(a,b);release();await a;assert.equal(calls,1);assert.equal(repository.get(job.id).status,'queued');await scheduler.tick();assert.equal(calls,1);now=1100;await scheduler.tick();assert.equal(calls,2);assert.equal(repository.get(job.id).status,'failed');await scheduler.stop();
});
test('waiting for a safe point does not exhaust failure budget',async t=>{
 const {repository}=await fixture(t);let now=0,calls=0;const scheduler=new Scheduler(repository,{maintenance:async()=>({status:++calls<=4?'waiting':'succeeded'})},()=>now,{maxAttempts:2});const job=scheduler.enqueue('wait','maintenance',{});for(let i=0;i<5;i++){await scheduler.tick();now+=60_000;}assert.equal(repository.get(job.id).status,'succeeded');assert.equal(calls,5);await scheduler.stop();
});

test('an old waiting job yields to queued work and both continue progressing',async t=>{
 const {repository}=await fixture(t);let now=0;const calls=[];const scheduler=new Scheduler(repository,{maintenance:async job=>{calls.push(job.key);return{status:job.key==='old'?'waiting':'succeeded'};}},()=>now);
 scheduler.enqueue('old','maintenance',{});await scheduler.tick();now=500;const fresh=scheduler.enqueue('fresh','maintenance',{});now=1000;await scheduler.tick();assert.equal(repository.get(fresh.id).status,'succeeded');now=2000;await scheduler.tick();assert.deepEqual(calls,['old','fresh','old']);await scheduler.stop();
});
