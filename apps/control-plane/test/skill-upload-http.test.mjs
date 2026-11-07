import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from '../dist/server.js';
test('workspace admin can upload before any employee exists, without creating configuration or granting use',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dentity-skill-http-')),databasePath=join(dir,'db.sqlite'),origin='http://127.0.0.1:15173',app=createServer({databasePath,origin,skillResourceRoot:join(dir,'sources')});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const request=async(method,url,payload,cookie)=>{const r=await app.inject({method,url,headers:{origin,...(cookie?{cookie}:{})},...(payload===undefined?{}:{payload})});return{status:r.statusCode,body:r.json(),cookie:r.headers['set-cookie']?.split(';')[0]};};
 const a=await request('POST','/api/auth/register',{username:'upload-owner',password:'Synthetic upload test password 2026!'}),b=await request('POST','/api/auth/register',{username:'upload-guest',password:'Synthetic upload test password 2026!'});assert.equal(a.status,201);const base='/api/workspaces/'+a.body.workspace.id;
 const invite=await request('POST',base+'/invitations',{role:'member'},a.cookie);assert.equal((await request('POST','/api/invitations/accept',{token:invite.body.token},b.cookie)).status,200);
 const body={operationId:'upload-before-employee',filename:'SKILL.md',content:await readFile(new URL('../../../mock/skills/alpha/SKILL.md',import.meta.url),'utf8')};
 assert.equal((await request('POST',base+'/skill-resources',body,b.cookie)).status,200);assert.equal((await request('POST',base+'/skill-resources',body)).status,401);
 const first=await request('POST',base+'/skill-resources',body,a.cookie);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.version,1);assert.deepEqual((await request('POST',base+'/skill-resources',body,a.cookie)).body,first.body);
 const list=await request('GET',base+'/resource-catalog',undefined,a.cookie);assert.equal(list.status,200);assert.equal(list.body[0].id,first.body.resource.id);assert.equal((await request('GET',base+'/resource-catalog',undefined,b.cookie)).status,200);
 const db=new DatabaseSync(databasePath,{readOnly:true});try{for(const table of ['entities','capability_packages','model_catalog','entity_model_bindings'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0,table+' is not created by resource upload');assert.equal(db.prepare('SELECT count(*) n FROM skill_resource_versions').get().n,1);}finally{db.close();}
 assert.ok((await readdir(dir)).includes('sources'));
});
