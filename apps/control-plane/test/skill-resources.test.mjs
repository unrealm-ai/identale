import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile,symlink,stat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../dist/store.js';
import {SkillResources} from '../dist/skill-resources.js';
async function fixture(t){const dir=await realpath(await mkdtemp(join(tmpdir(),'dentity-skill-store-'))),store=new Store(join(dir,'db.sqlite'));store.run('INSERT INTO users(id,username,display_name) VALUES(?,?,?)','user','test-user','Test');for(const w of ['a','b'])store.run('INSERT INTO workspaces VALUES(?,?,?,?)',w,w,'user','active');t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return{dir,store,skills:new SkillResources(store,join(dir,'resources')),body:{filename:'SKILL.md',content:await readFile(new URL('../../../mock/skills/alpha/SKILL.md',import.meta.url),'utf8'),operationId:'first'}};}
test('workspace version store is private, idempotent, immutable and root-aware',async t=>{
 const {dir,store,skills,body}=await fixture(t);assert.equal((await readdir(dir)).includes('resources'),false,'startup does not create a resource directory');const first=skills.upload('a',body);assert.deepEqual(skills.upload('a',body),first);const second=skills.upload('a',{...body,operationId:'second',content:body.content+'\nVersion2\n'});assert.equal(second.resource.resourceId,first.resource.resourceId);assert.equal(second.version,2);assert.equal(skills.resources('a').length,1);assert.equal(skills.read('a',first.resource).content,body.content);
 const lost={...body,operationId:'lost-sql-commit',content:body.content+'\nVersion3\n'};assert.throws(()=>store.transaction(()=>{skills.upload('a',lost);throw new Error('rollback after file persistence');}));const recovered=skills.upload('a',lost);assert.equal(recovered.version,3);assert.equal(skills.read('a',recovered.resource).content,lost.content,'retry can recover an identical unindexed file without overwriting other data');
 const other=skills.upload('b',body);assert.notEqual(first.resource.resourceId,other.resource.resourceId);assert.throws(()=>skills.read('b',first.resource),/skill_not_found/);
 const file=store.one('SELECT path FROM skill_resource_versions WHERE workspace_id=? AND version=?','a',1).path;assert.equal((await stat(file)).mode&0o777,0o600);assert.ok(file.includes('/resources/'));assert.throws(()=>new SkillResources(store,join(dir,'new-root')).read('a',first.resource),/skill_storage_changed/);
 await writeFile(file,'tampered');assert.throws(()=>skills.read('a',first.resource),/skill_digest_changed/);
});
test('single Markdown validation rejects archives/paths/complex YAML and symlink roots',async t=>{
 const {dir,store,skills,body}=await fixture(t);for(const value of [{...body,filename:'../SKILL.md'},{...body,filename:'skills.zip'},{...body,content:'---\nname: duplicate\nname: duplicate\ndescription: x\n---\nbody'},{...body,content:'---\nname: name\ndescription: x\nextra: unsupported\n---\nbody'},{...body,content:'x'.repeat(65537)}])assert.throws(()=>skills.upload('a',value));
 await symlink(dir,join(dir,'alias'));assert.throws(()=>new SkillResources(store,join(dir,'alias')),/symlink/);assert.equal(store.one('SELECT count(*) n FROM skill_resource_versions').n,0);
});

test('publishing a legacy Skill advances status CAS and preserves a disabled resource',async t=>{const {store,skills,body}=await fixture(t),first=skills.upload('a',body);store.run('DELETE FROM skill_resource_state WHERE workspace_id=?','a');skills.upload('a',{...body,operationId:'legacy-next',content:body.content+'\nNext version\n'});let item=skills.list('a')[0];assert.equal(item.revision,2);assert.throws(()=>skills.status('a',item.id,{enabled:false,expectedVersion:1}),/version_conflict/);skills.status('a',item.id,{enabled:false,expectedVersion:2});skills.upload('a',{...body,operationId:'disabled-next',content:body.content+'\nDisabled version\n'});item=skills.list('a')[0];assert.equal(item.enabled,false);assert.equal(item.revision,4);assert.equal(item.version,3);assert.equal(skills.read('a',first.resource).content,body.content);});
