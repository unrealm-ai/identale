import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {childEnvironments} from '../local/local-start.mjs';

test('DingTalk registration source is an explicit platform-only option, never a default',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'identale-ding-source-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const checkout=join(root,'checkout'),home=join(root,'home');await mkdir(checkout);await mkdir(home);
 const env={HOME:home,PATH:process.env.PATH};
 const defaults=await childEnvironments(env,{root:checkout});
 assert.equal(defaults.platform.DENTITY_DINGTALK_REGISTRATION_SOURCE,undefined);
 const configured=await childEnvironments({...env,DENTITY_DINGTALK_REGISTRATION_SOURCE:'IDENTALE_TEST'},{root:checkout});
 assert.equal(configured.platform.DENTITY_DINGTALK_REGISTRATION_SOURCE,'IDENTALE_TEST');
 for(const key of ['runtime','host','web','mockModel','mockMcp','build'])assert.equal(configured[key].DENTITY_DINGTALK_REGISTRATION_SOURCE,undefined,key);
});
