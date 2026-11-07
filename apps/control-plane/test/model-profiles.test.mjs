import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createCipheriv} from 'node:crypto';
import Fastify from 'fastify';
import { Store } from '../dist/store.js';
import { ModelProfileService, registerModelProfileRoutes } from '../dist/model-profiles.js';
const fakeKey = Buffer.alloc(32, 7); // Synthetic test-only key, never a deployment credential.
const secret = 'synthetic-unit-test-secret-not-a-real-api-key';
const input = {provider:'openai-compatible',endpoint:'https://provider.example/v1',modelId:'test-model',apiKey:secret};
function setup(t, options = { masterKey:fakeKey }) {
  const dir = mkdtempSync(join(tmpdir(),'dentity-model-test-')), path = join(dir,'test.sqlite'), store = new Store(path);
  store.run("INSERT INTO users(id,username,display_name) VALUES('u','user','User')");
  store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u'),('other','Other','u')");
  store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");
  store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Entity','m','m',1,'u','builtin')");
  const service = new ModelProfileService(store,options);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,service,path};
}
const scope = p => ({workspaceId:p.workspaceId,entityId:'e',profileId:p.id,configRevision:p.configRevision,purpose:'model-inference'});
const code = expected => error => error.code === expected;
test('encrypted at rest, metadata-only reads, restart and purpose-bound resolution', async t => {
  const {service,store,path} = setup(t), profile = service.save('w','e',input);
  assert.ok(profile.secretRef);
  assert.equal(JSON.stringify(profile).includes(secret),false);
  assert.equal(JSON.stringify(service.get('w','e')).includes(secret),false);
  assert.equal(JSON.stringify(store.one('SELECT * FROM model_catalog')).includes(secret),false);
  for (const file of [path,path+'-wal']) assert.equal(readFileSync(file).includes(Buffer.from(secret)),false);
  const resumed = new ModelProfileService(store,{masterKey:fakeKey});
  assert.equal((await resumed.resolve(scope(profile),()=>true)).apiKey,secret);
  await assert.rejects(service.resolve(scope(profile),()=>false),code('model_credential_forbidden'));
  await assert.rejects(service.resolve({...scope(profile),workspaceId:'other'},()=>true),code('model_profile_unavailable'));
  await assert.rejects(service.resolve({...scope(profile),purpose:'export'},()=>true),code('model_credential_forbidden'));
  await assert.rejects(service.resolve({...scope(profile),configRevision:999},()=>true),code('model_profile_unavailable'));
});
test('endpoint change requires explicit credential replacement or clearing', async t => {
  const {service} = setup(t); const p = service.save('w','e',input);
  assert.throws(()=>service.save('w','e',{...input,endpoint:'https://other.example/v1',apiKey:undefined}),code('endpoint_change_requires_credential_replacement'));
  const cleared = service.save('w','e',{...input,endpoint:'https://other.example/v1',apiKey:null});
  assert.equal(cleared.secretRef,null);
  await assert.rejects(service.resolve(scope(cleared),()=>true),code('model_credential_missing'));
  await assert.rejects(service.resolve(scope(p),()=>true),code('model_profile_unavailable'));
  const replaced = service.save('w','e',{...input,apiKey:'replacement-synthetic-secret'});
  assert.equal((await service.resolve(scope(replaced),()=>true)).apiKey,'replacement-synthetic-secret');
});
test('disabled/deleted profiles and corrupt ciphertext fail closed', async t => {
  const {service,store} = setup(t); const p = service.save('w','e',input);
  store.run("UPDATE model_catalog SET tag=?",Buffer.alloc(16).toString('base64'));
  await assert.rejects(service.resolve(scope(p),()=>true),code('model_credential_unavailable'));
  assert.throws(()=>service.save('w','e',{...input,apiKey:undefined}),code('model_credential_unavailable'));
  const disabled = service.save('w','e',{...input,enabled:false});
  await assert.rejects(service.resolve(scope(disabled),()=>true),code('model_profile_unavailable'));
  service.delete('w','e'); service.deleteProfile('w',p.id);
  await assert.rejects(service.resolve(scope(p),()=>true),code('model_profile_unavailable'));
});
test('missing deployment master key permits startup/metadata but rejects real credentials', async t => {
  const {service,store} = setup(t,{});
  assert.equal(service.get('w','e'),null);
  assert.throws(()=>service.save('w','e',input),code('model_secret_store_unconfigured'));
  await assert.rejects(service.resolve({workspaceId:'w',entityId:'e',profileId:'p',configRevision:1,purpose:'model-inference'},()=>true),code('model_secret_store_unconfigured'));
  assert.throws(()=>new ModelProfileService(store,{masterKey:Buffer.alloc(2)}),code('model_secret_key_invalid'));
});
test('endpoint restrictions retain TLS, URL structure and loopback opt-in', t => {
  const {service} = setup(t);
  for(const endpoint of ['http://provider.example','https://provider.example/v1?key=hidden','https://user:pass@provider.example/v1','https://provider.example/v1#key','file:///etc/passwd','http://127.0.0.1:9000']) assert.throws(()=>service.save('w','e',{...input,endpoint}));
});
test('HTTPS domains and ports need no allowlist; saved profiles resolve after restart without rewriting', async t => {
  const {service,store}=setup(t);
  for(const endpoint of ['https://custom-provider.example/v1','https://another-provider.example:8443/custom/v1']){
    const profile=service.save('w','e',{...input,endpoint});
    const before=store.one('SELECT * FROM model_catalog WHERE id=?',profile.id);
    const resumed=new ModelProfileService(store,{masterKey:fakeKey});
    assert.equal(resumed.assertUsable('w','e').endpoint,endpoint);
    assert.deepEqual(await resumed.resolve(scope(profile),()=>true),{provider:input.provider,endpoint,modelId:input.modelId,apiKey:secret});
    assert.deepEqual(store.one('SELECT * FROM model_catalog WHERE id=?',profile.id),before);
  }
});
test('loopback HTTP flag permits localhost, IPv4 and IPv6 on different ports', async t => {
  const {service}=setup(t,{masterKey:fakeKey,allowLoopbackHttp:true});
  for(const endpoint of ['http://localhost:18302/v1','http://127.0.0.1:18303/v1','http://[::1]:19000/v1']){
    const profile=service.save('w','e',{...input,endpoint});
    assert.equal((await service.resolve(scope(profile),()=>true)).endpoint,endpoint);
  }
});
test('catalog reads and selection require workspace and employee management authorization', async t => {
  const {service} = setup(t); const p = service.save('w','e',input), app = Fastify();
  const manager = request => { if (request.headers['x-test-role'] !== 'manager') { const error = new Error('forbidden'); error.statusCode = 403; throw error; } };
  await registerModelProfileRoutes(app,service,{requireManager:manager,requireWorkspaceMember:manager,requireWorkspaceManager:manager,currentUser:()=>({id:'u'})});
  t.after(()=>app.close());
  const url='/api/workspaces/w/entities/e/model-profile', headers={'x-test-role':'manager'};
  assert.equal((await app.inject({method:'PUT',url,payload:{profileId:p.id}})).statusCode,403);
  const response=await app.inject({method:'PUT',url,headers,payload:{profileId:p.id}});
  assert.equal(response.statusCode,200);assert.equal(response.body.includes(secret),false);assert.equal(response.json().selectedProfileId,p.id);
  assert.equal((await app.inject({url})).statusCode,403);
  const catalog=await app.inject({url:'/api/workspaces/w/model-profiles',headers});
  assert.equal(catalog.statusCode,200);assert.equal(catalog.json().profiles.length,1);assert.equal(catalog.body.includes(secret),false);
});
test('model DTO and credentials contain connection settings only; legacy columns do not alter ciphertext or binding',async t=>{
 const {service,store}=setup(t);const initial=service.save('w','e',input);
 for(const field of ['interactionThinking','interactionThinkingControl','executionThinking','executionThinkingControl']){
  assert.equal(field in initial,false);assert.throws(()=>service.save('w','e',{...input,[field]:'medium'}),code('model_thinking_configuration_removed'));
 }
 store.run("UPDATE model_catalog SET interaction_thinking_control='qwen_enable_thinking_false',execution_thinking_control='openai_reasoning_effort_medium'");
 const before=store.one('SELECT * FROM model_catalog WHERE id=?',initial.id);
 const resumed=new ModelProfileService(store,{masterKey:fakeKey});
 assert.deepEqual(await resumed.resolve(scope(initial),()=>true),{provider:input.provider,endpoint:input.endpoint,modelId:input.modelId,apiKey:secret});
 assert.equal(resumed.effective('w','e').id,initial.id);assert.deepEqual(store.one('SELECT * FROM model_catalog WHERE id=?',initial.id),before);
 const updated=resumed.save('w','e',{...input,apiKey:undefined,name:'Connection rename'});assert.equal(updated.secretRef,initial.secretRef);assert.equal(store.one('SELECT interaction_thinking_control FROM model_catalog').interaction_thinking_control,'qwen_enable_thinking_false');
});
test('legacy encrypted employee rows migrate once without changing identity or AAD',async t=>{
 const {store}=setup(t);
 store.run("DELETE FROM model_catalog_migrations WHERE id='legacy-employee-v1'");
 const nonce=Buffer.alloc(12,2),cipher=createCipheriv('aes-256-gcm',fakeKey,nonce);
 cipher.setAAD(Buffer.from(JSON.stringify(['w','e','legacy',input.endpoint,input.modelId,'legacy-secret',4,'model-inference'])));
 const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]).toString('base64');
 store.run('INSERT INTO model_profiles(id,workspace_id,entity_id,provider,endpoint,model_id,secret_ref,revision,enabled,ciphertext,nonce,tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)','legacy','w','e',input.provider,input.endpoint,input.modelId,'legacy-secret',4,1,ciphertext,nonce.toString('base64'),cipher.getAuthTag().toString('base64'));
 store.db.exec('ALTER TABLE model_profiles DROP COLUMN interaction_thinking_control');
 const migrated=new ModelProfileService(store,{masterKey:fakeKey});
 const old=migrated.get('w','e');assert.equal(old.id,'legacy');assert.equal(old.configRevision,4);
 assert.equal('interactionThinking' in old,false);assert.equal('interactionThinkingControl' in old,false);
 assert.equal((await migrated.resolve(scope(old),()=>true)).apiKey,secret);
 const again=new ModelProfileService(store,{masterKey:fakeKey});assert.deepEqual(again.get('w','e'),old);
 migrated.delete('w','e');migrated.deleteProfile('w','legacy');
 new ModelProfileService(store,{masterKey:fakeKey});
 assert.equal(migrated.hasCatalog('w'),false,'Legacy backup must not resurrect removed catalog entries');
});
test('workspace catalog supports inheritance, explicit selection, sharing and safe reference deletion',async t=>{
 const {service,store}=setup(t);
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e2','w','Second','m','m',1,'u','builtin')");
 assert.equal(service.effective('w','e'),null);assert.equal(service.hasCatalog('w'),false);
 const ws=service.saveWorkspace('w',{...input,name:'Workspace default'});
 assert.equal(service.effective('w','e').source,'workspace_default');assert.equal(service.effective('w','e').id,ws.id);
 const selected=service.save('w','e',{...input,name:'Employee selected',modelId:'alternate'});
 assert.equal(service.list('w').length,2);assert.equal(service.effective('w','e').source,'selection');
 assert.equal(service.effective('w','e2').id,ws.id);
 service.select('w','e2',selected.id);assert.equal(service.getProfile('w',selected.id).referenceCount,2);
 assert.throws(()=>service.deleteProfile('w',selected.id),code('model_profile_in_use'));
 assert.throws(()=>service.select('other','e',ws.id),code('entity_not_found'));
 assert.equal(service.effective('other','e'),null);assert.equal(service.getProfile('other',selected.id),null);
 service.select('w','e',null);assert.equal(service.effective('w','e').id,ws.id);
 service.select('w','e2',null);service.deleteProfile('w',selected.id);
 service.setDefault('w',null);assert.equal(service.effective('w','e'),null);assert.equal(service.hasCatalog('w'),true);
 assert.equal(service.revisionKey('w','e'),'model_selection_required');
 service.deleteProfile('w',ws.id);assert.equal(service.revisionKey('w','e'),'model_not_configured');
});
test('disabled selection never falls through and binding epochs prevent A to B to A credential reuse',async t=>{
 const {service}=setup(t);const a=service.saveWorkspace('w',input);
 const first=service.effective('w','e'),key=service.revisionKey('w','e');
 const bound={...scope(first),source:first.source,bindingRevision:first.bindingRevision};
 assert.equal((await service.resolve(bound,()=>true)).apiKey,secret);
 const b=service.save('w','e',{...input,enabled:false});
 assert.equal(service.effective('w','e').id,b.id);await assert.rejects(service.resolve({...scope(b),source:'selection'},()=>true),code('model_profile_unavailable'));
 service.select('w','e',null);assert.equal(service.effective('w','e').id,a.id);assert.notEqual(service.revisionKey('w','e'),key);
 await assert.rejects(service.resolve(bound,()=>true),code('model_profile_unavailable'));
 const before=service.effective('w','e');service.setDefault('w',null);service.setDefault('w',a.id);
 assert.notEqual(service.effective('w','e').bindingRevision,before.bindingRevision);
});

test('credential revocation is atomic, disables shared users and invalidates old resolutions',async t=>{
 const {service,store}=setup(t);const p=service.saveWorkspace('w',input),before=service.effective('w','e');
 const revoked=service.revoke('w',p.id);
 assert.equal(revoked.enabled,false);assert.equal(revoked.secretRef,null);assert.equal(revoked.configRevision,p.configRevision+1);
 const row=store.one('SELECT * FROM model_catalog WHERE id=?',p.id);
 for(const key of ['secret_ref','ciphertext','nonce','tag']) assert.equal(row[key],null);
 assert.equal(service.effective('w','e').id,p.id,'Disabled configured profiles must not become demo or fall back');
 await assert.rejects(service.resolve({...scope(before),source:before.source,bindingRevision:before.bindingRevision},()=>true),code('model_profile_unavailable'));
});

test('shared connection never owns or overwrites two employees execution levels',async t=>{
 const {service,store}=setup(t),profile=service.save('w','e',input);
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime,execution_thinking_level) SELECT 'second',workspace_id,'Second',owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime,'high' FROM entities WHERE id='e'");
 store.run("UPDATE entities SET execution_thinking_level='none' WHERE id='e'");service.select('w','second',profile.id);
 assert.equal(service.effective('w','second').id,service.effective('w','e').id);
 service.save('w','e',{...input,apiKey:undefined,name:'Shared connection edited'});
 assert.deepEqual(store.all('SELECT execution_thinking_level AS level FROM entities ORDER BY id').map(r=>r.level),['none','high']);
});
test('reversible disable retains encrypted credential and references, revoke remains destructive and status is CAS',async t=>{const {service,store}=setup(t),p=service.save('w','e',input),before=store.one('SELECT ciphertext,nonce,tag FROM model_catalog WHERE id=?',p.id);const disabled=service.setEnabled('w',p.id,{enabled:false,expectedVersion:p.configRevision});assert.equal(disabled.enabled,false);assert.equal(service.selectedProfileId('w','e'),p.id);assert.ok(store.one('SELECT ciphertext FROM model_catalog WHERE id=?',p.id).ciphertext);assert.notEqual(store.one('SELECT nonce FROM model_catalog WHERE id=?',p.id).nonce,before.nonce);assert.throws(()=>service.assertEnabledProfile('w',p.id),code('model_profile_unavailable'));assert.throws(()=>service.setEnabled('w',p.id,{enabled:true,expectedVersion:p.configRevision}),code('model_profile_changed'));const enabled=service.setEnabled('w',p.id,{enabled:true,expectedVersion:disabled.configRevision});service.assertEnabledProfile('w',p.id);const current=service.effective('w','e');assert.equal((await service.resolve(scope(current),()=>true)).apiKey,secret);const revoked=service.revoke('w',p.id);assert.equal(revoked.secretRef,null);assert.throws(()=>service.setEnabled('w',p.id,{enabled:true,expectedVersion:revoked.configRevision}),code('model_profile_unavailable'));assert.equal(enabled.enabled,true);});
