// Modified for Identale; see the root NOTICE.
import { testHome } from './helpers/local-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, spawnSync, execFileSync} from 'node:child_process';
import {once, EventEmitter} from 'node:events';
import {initializeLocalInstallation, childEnvironments} from '../local/local-start.mjs';
import {readSecrets, secretPath, repositoryRoot} from '../shared/local-secrets.mjs';
import {assertNoServerInstance, recoverProcesses} from '../local/local-recovery.mjs';
import {assertNoLocalLauncher, assertStorageOwnership, existingSkillRoot} from '../deploy/setup-systemd.mjs';
import {superviseLocal} from '../local/local-start.mjs';
import {deploymentConfiguration, primaryCredentials} from '../deploy/deployment-config.mjs';
import {environmentFile, environmentText, environmentPaths, environmentWords, protectedEnvironment} from '../deploy/deployment-environment.mjs';
import {DatabaseSync} from 'node:sqlite';

async function fixture(t) {
  // macOS's per-user os.tmpdir() can exceed the Unix socket path limit.
  // Match the existing local-restart fixtures; retain the production guard.
  const base = await fs.realpath(await fs.mkdtemp('/tmp/identity-start-'));
  t.after(() => fs.rm(base, {recursive:true, force:true}));
  const root=path.join(base,'checkout');await fs.mkdir(root);
  return {root, env:{HOME:path.join(base,'home'), XDG_CONFIG_HOME:path.join(base,'config')}};
}
const credentials = {DENTITY_MODEL_MASTER_KEY:Buffer.alloc(32,17).toString('base64'), DENTITY_RUNTIME_HOST_TOKEN:'a'.repeat(43), DENTITY_PLATFORM_RESOLVER_TOKEN:'b'.repeat(43)};

test('single entry help and invalid server options have no initialization side effects', async t => {
  const {root,env} = await fixture(t);
  await fs.mkdir(path.join(root,'scripts'));
  await fs.copyFile(path.join(repositoryRoot,'scripts/start.sh'),path.join(root,'scripts/start.sh'));
  const start = path.join(root,'scripts/start.sh');
  const output = execFileSync('bash',[start,'--help'],{env:{...env,PATH:process.env.PATH},encoding:'utf8'});
  assert.match(output,/No arguments/);assert.match(output,/--host/);
  assert.deepEqual(await fs.readdir(root),['scripts']);
  assert.equal(await readSecrets({env,root}),undefined);
  for (const args of [['--bogus'],['--host'],['--host','https://bad.example'],['--host','example.com','--port','18304'],['--host','example.com','--cert','/tmp/absent.crt']]) {
    assert.throws(()=>execFileSync('bash',[start,...args],{env:{...env,PATH:process.env.PATH},stdio:'pipe'}));
    assert.deepEqual(await fs.readdir(root),['scripts']);
    assert.equal(await readSecrets({env,root}),undefined);
  }
  const help = execFileSync('bash',[start,'--host','example.com','--help'],{env:{...env,PATH:process.env.PATH},encoding:'utf8'});
  assert.match(help,/sudo bash scripts\/start.sh --host/);
});

test('fresh local initialization is private, stable, concurrent-safe and ready for both adapters', async t => {
  const {root,env} = await fixture(t);
  const attempts=await Promise.allSettled([initializeLocalInstallation(env,root),initializeLocalInstallation(env,root)]);
  assert.ok(attempts.some(result=>result.status==='fulfilled'));
  for(const result of attempts)if(result.status==='rejected')assert.match(result.reason.message,/initialization/);
  const before = await fs.readFile(secretPath(env));
  await initializeLocalInstallation(env,root);
  assert.deepEqual(await fs.readFile(secretPath(env)),before);
  assert.equal((await fs.stat(secretPath(env))).mode&0o777,0o600);
  assert.equal((await fs.stat(path.dirname(secretPath(env)))).mode&0o777,0o700);
  const children=await childEnvironments(env);
  assert.ok(children.platform.DENTITY_MODEL_MASTER_KEY);
  assert.ok(children.host.DENTITY_RUNTIME_HOST_TOKEN);
  for (const scope of ['runtime','host','mockModel','mockMcp','web','build']) assert.equal(children[scope].DENTITY_MODEL_MASTER_KEY,undefined);
  assert.equal(children.platform.DENTITY_APP_ORIGIN,'http://127.0.0.1:15173');
  assert.equal(children.runtime.DENTITY_SECURE_COOKIES,'false');
  // Run the actual shell/Node entry chain in an empty copied checkout. Missing
  // dependencies stop it before installation, build or any business service.
  await fs.cp(path.join(repositoryRoot,'scripts'),path.join(root,'scripts'),{recursive:true,filter:source=>!path.relative(path.join(repositoryRoot,'scripts'),source).split(path.sep).includes('test')});
  await fs.copyFile(path.join(repositoryRoot, '.env.example'), path.join(root, '.env.example'));
  const first=spawnSync('bash',[path.join(root,'scripts/start.sh'),'--no-install','--no-build'],{cwd:root,env:{...env,PATH:process.env.PATH},encoding:'utf8',timeout:15000});
  assert.equal(first.status,1,first.stderr);assert.match(first.stderr,/Dependencies are missing/);
  assert.deepEqual(await fs.readFile(secretPath(env)),before);
});

test('local initialization never replaces lost keys, partial external credentials or corrupt secrets',async t=>{
  const {root,env}=await fixture(t);
  const data=path.join(env.HOME,'.identale/platform');await fs.mkdir(data,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(data,'platform.sqlite'),'existing database sentinel');
  await assert.rejects(initializeLocalInstallation(env,root),/original key/);
  assert.equal(await readSecrets({env,root}),undefined);
  await assert.rejects(initializeLocalInstallation({...env,DENTITY_MODEL_MASTER_KEY:credentials.DENTITY_MODEL_MASTER_KEY},root),/Partial/);
  await initializeLocalInstallation({...env,...credentials},root);
  assert.equal(await readSecrets({env,root}),undefined);
  await fs.rm(path.join(data,'platform.sqlite'));
  await initializeLocalInstallation(env,root);
  await fs.writeFile(secretPath(env),'corrupt');
  await assert.rejects(initializeLocalInstallation(env,root),/invalid/);
  assert.equal(await fs.readFile(secretPath(env),'utf8'),'corrupt');
});

test('three-service deployment keeps scoped tokens stable and preserves active storage/custom settings',()=>{
  const platform={...credentials,DENTITY_DATABASE_PATH:'/data/platform/platform.sqlite',CUSTOM_FLAG:'keep',DENTITY_PLATFORM_RESOLVER_URL:'http://127.0.0.1:18300/internal/runtime'};
  const runtime={DENTITY_RUNTIME_DATABASE_PATH:'/data/runtime/runtime.sqlite',DENTITY_BUILTIN_RECORD_ROOT:'/data/runtime/records',CUSTOM_RUNTIME:'keep'};
  const host={DENTITY_RUNTIME_HOST_STATE_DIR:'/data/pi',DENTITY_MODEL_MASTER_KEY:credentials.DENTITY_MODEL_MASTER_KEY};
  const result=deploymentConfiguration({platform,runtime,host,credentials,origin:'https://identity.example.com'});
  const second=deploymentConfiguration({...result,credentials,origin:'https://identity.example.com'});
  assert.deepEqual(second,result);
  for(const scope of ['platform','runtime','host'])assert.equal(result[scope].NODE_ENV,'production');
  assert.equal(result.platform.CUSTOM_FLAG,'keep');assert.equal(result.runtime.CUSTOM_RUNTIME,'keep');
  assert.equal(result.platformDatabase,'/data/platform/platform.sqlite');assert.equal(result.runtimeDatabase,'/data/runtime/runtime.sqlite');assert.equal(result.records,'/data/runtime/records');assert.equal(result.state,'/data/pi');
  assert.equal(result.platform.DENTITY_RUNTIME_HOST_TOKEN,undefined);assert.equal(result.platform.DENTITY_PLATFORM_RESOLVER_TOKEN,undefined);assert.equal(result.platform.DENTITY_PLATFORM_RESOLVER_URL,undefined);
  assert.equal(result.runtime.DENTITY_MODEL_MASTER_KEY,undefined);assert.equal(result.host.DENTITY_MODEL_MASTER_KEY,undefined);
  assert.equal(result.runtime.DENTITY_SECURE_COOKIES,'true');assert.equal(result.runtime.DENTITY_APP_ORIGIN,result.platform.DENTITY_APP_ORIGIN);
  assert.equal(result.host.DENTITY_PLATFORM_RESOLVER_URL,undefined);assert.equal(result.host.DENTITY_PLATFORM_RESOLVER_TOKEN,undefined);
  for(const scope of ['platform','runtime','host'])assert.equal(result[scope].HOME,'/var/lib/identity/service-home');
  assert.equal(result.platform.DENTITY_SKILL_RESOURCE_ROOT,'/data/platform/skills');
  assert.equal(result.runtime.DENTITY_PLATFORM_CONFIG_TOKEN,result.platform.DENTITY_PLATFORM_CONFIG_TOKEN);
  assert.equal(result.host.DENTITY_PI_MONITOR_TOKEN,result.platform.DENTITY_PI_MONITOR_TOKEN);
  assert.equal(new Set([result.runtime.DENTITY_PLATFORM_CONFIG_TOKEN,result.runtime.DENTITY_RUNTIME_SERVICE_TOKEN,result.host.DENTITY_PI_MONITOR_TOKEN,result.host.DENTITY_RUNTIME_HOST_TOKEN]).size,4);
  assert.throws(()=>deploymentConfiguration({platform,runtime,host,credentials,origin:'https://identity.example.com',dataDir:'/new'}),/migration/);
  assert.throws(()=>deploymentConfiguration({credentials,origin:'https://identity.example.com',platform:{DENTITY_DATABASE_PATH:'/same'},runtime:{DENTITY_RUNTIME_DATABASE_PATH:'/same'}}),/distinct/);
});

test('server configuration preserves explicit or legacy Skill storage while replacing privileged HOME',()=>{
  const base={credentials,origin:'https://identity.example.com'};
  const legacy=deploymentConfiguration({...base,platform:{HOME:'/root'},runtime:{HOME:'/root'},host:{HOME:'/root'},legacySkillRoot:'/root/.identity/resources/skills'});
  assert.equal(legacy.platform.DENTITY_SKILL_RESOURCE_ROOT,'/root/.identity/resources/skills');
  for(const scope of ['platform','runtime','host'])assert.equal(legacy[scope].HOME,'/var/lib/identity/service-home');
  const explicit=deploymentConfiguration({...base,platform:{DENTITY_SKILL_RESOURCE_ROOT:'/data/approved-skills'},legacySkillRoot:'/root/.identity/resources/skills'});
  assert.equal(explicit.platform.DENTITY_SKILL_RESOURCE_ROOT,'/data/approved-skills');
  assert.equal(explicit.platform.DENTITY_MODEL_MASTER_KEY,credentials.DENTITY_MODEL_MASTER_KEY);
  assert.equal(explicit.host.DENTITY_RUNTIME_HOST_TOKEN,credentials.DENTITY_RUNTIME_HOST_TOKEN);
});

test('legacy Skill references retain their implicit path even if the files are missing, without modifying the database',async t=>{
  const {root}=await fixture(t),home=path.join(root,'old-home'),database=path.join(root,'platform.sqlite');
  assert.equal(existingSkillRoot(database,{HOME:home}),undefined);
  const db=new DatabaseSync(database);db.exec('CREATE TABLE skill_resource_versions(path TEXT)');db.close();
  assert.equal(existingSkillRoot(database,{HOME:home}),undefined);
  const writer=new DatabaseSync(database);writer.exec("INSERT INTO skill_resource_versions VALUES('/synthetic/missing-skill')");writer.close();
  const before=await fs.readFile(database);
  assert.equal(existingSkillRoot(database,{HOME:home}),path.join(home,'.identity/resources/skills'));
  assert.equal(existingSkillRoot(database,{HOME:home,DENTITY_SKILL_RESOURCE_ROOT:'/data/explicit-skills'}),undefined);
  assert.deepEqual(await fs.readFile(database),before);
  await assert.rejects(fs.access(home),{code:'ENOENT'});
});

test('credential adoption rejects partial/conflicting/lost sources and never invents a replacement',()=>{
  assert.equal(primaryCredentials([{}]),undefined);
  assert.deepEqual(primaryCredentials([credentials]),credentials);
  const stored={version:1,modelMasterKey:credentials.DENTITY_MODEL_MASTER_KEY,runtimeHostToken:credentials.DENTITY_RUNTIME_HOST_TOKEN,platformResolverToken:credentials.DENTITY_PLATFORM_RESOLVER_TOKEN};
  assert.deepEqual(primaryCredentials([credentials],stored),credentials);
  assert.throws(()=>primaryCredentials([{DENTITY_MODEL_MASTER_KEY:credentials.DENTITY_MODEL_MASTER_KEY}]),/Partial/);
  assert.throws(()=>primaryCredentials([credentials,{DENTITY_MODEL_MASTER_KEY:Buffer.alloc(32,18).toString('base64')}]),/Conflicting/);
  assert.throws(()=>deploymentConfiguration({credentials,origin:'https://example.com',platform:{DENTITY_PLATFORM_CONFIG_TOKEN:'x'.repeat(43)},runtime:{DENTITY_RUNTIME_SERVICE_TOKEN:'x'.repeat(43)}}),/distinct/);
});

test('effective systemd environment files/quotes round trip without executing shell fragments',async t=>{
  const {root}=await fixture(t);const marker=path.join(root,'must-not-execute');
  const values={NODE_ENV:'production',CUSTOM:`$(touch ${marker})`,SPACE:'/data/with spaces',BACKSLASH:'a\\b',QUOTES:'"quoted"',DOLLAR:'$HOME'};
  assert.deepEqual(environmentFile(environmentText(values)),values);
  const metadata='/etc/identity/first.env (ignore_errors=no) /etc/identity/with spaces.env (ignore_errors=yes)';
  assert.deepEqual(environmentPaths(metadata),[{file:'/etc/identity/first.env',optional:false},{file:'/etc/identity/with spaces.env',optional:true}]);
  assert.deepEqual(environmentWords('NODE_ENV=production "CUSTOM=has spaces"'),{NODE_ENV:'production',CUSTOM:'has spaces'});
  assert.throws(()=>environmentPaths('/unexpected'),/Unsupported/);
  assert.throws(()=>environmentFile('X=one\nX=two'),/duplicate/);
  assert.throws(()=>environmentText({X:'a\nb'}),/Invalid/);
  const file=path.join(root,'private.env');await fs.writeFile(file,environmentText(values),{mode:0o600});
  assert.deepEqual(await protectedEnvironment(file),values);
  const alias=path.join(root,'alias');await fs.symlink(file,alias);await assert.rejects(protectedEnvironment(alias),/Unsafe/);
  await fs.chmod(file,0o666);await assert.rejects(protectedEnvironment(file),/Unsafe/);
  assert.deepEqual(await protectedEnvironment(path.join(root,'missing'),true),{});
  await assert.rejects(fs.access(marker),{code:'ENOENT'});
});

test('database ownership preflight is read-only and rejects a legacy all-in-one file',async t=>{
  const {root}=await fixture(t),p=path.join(root,'p.sqlite'),r=path.join(root,'r.sqlite');
  const db=new DatabaseSync(p);db.exec('CREATE TABLE users(id TEXT); CREATE TABLE tasks(id TEXT)');db.close();
  const before=await fs.readFile(p);
  await assert.rejects(assertStorageOwnership(p,r),/Legacy or wrong-owner/);
  assert.deepEqual(await fs.readFile(p),before);
  await assert.rejects(fs.access(r),{code:'ENOENT'});
});

test('server deployment refuses a live local launcher without stopping it',async t=>{
  const {root}=await fixture(t);const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const running=await superviseLocal({cwd:root,signalSource:new EventEmitter(),commands:[{name:'isolated listener',port,file:process.execPath,args:['-e',"require('node:net').createServer().listen(Number(process.argv[1]),'127.0.0.1')",String(port)],env:{HOME:testHome}}],timeoutMs:3000,killAfterMs:200,log(){}});
  t.after(async()=>{await running.stop();await running.completion;});
  await assert.rejects(assertNoLocalLauncher(root),/local launcher.*running/);
  assert.equal(running.started,true);
  assert.equal(process.kill(running.instance.pid,0),true);
});

test('deployment finds a pre-lease local process without metadata under a different HOME',async t=>{
  const {root}=await fixture(t),entry=path.join(root,'scripts/local/local-manager-entry.mjs');
  await fs.mkdir(path.dirname(entry),{recursive:true});
  await fs.writeFile(entry,"console.log('ready');setInterval(()=>{},1000)");
  const child=spawn(process.execPath,[entry],{cwd:root,env:{HOME:path.join(root,'ordinary-home')},stdio:['ignore','pipe','pipe']});
  const done=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await done;});
  await once(child.stdout,'data');
  await assert.rejects(assertNoLocalLauncher(root),/local launcher.*running/);
  assert.equal(process.kill(child.pid,0),true);
  await assert.rejects(fs.access(path.join(root,'.dentity')),{code:'ENOENT'});
});

test('local recovery refuses a server-marked actual process from the same checkout',async t=>{
  if(process.platform!=='linux'){t.skip('Linux /proc service inspection');return;}
  const {root}=await fixture(t);const script=path.join(root,'apps/control-plane/dist/main.js');await fs.mkdir(path.dirname(script),{recursive:true});await fs.writeFile(script,"console.log('ready');setInterval(()=>{},1000)");
  const binary=path.join(root,'managed Node','bin','node');await fs.mkdir(path.dirname(binary),{recursive:true});await fs.symlink(process.execPath,binary);
  const child=spawn(binary,[script],{cwd:root,env:{DENTITY_DEPLOYMENT:'server'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}});
  await once(child.stdout,'data');
  await assert.rejects(assertNoServerInstance(root),/server instance/);
  await assert.rejects(recoverProcesses(root,null),/server instance/);
  assert.equal(process.kill(child.pid,0),true);
});

test('generated server environments boot three real entry processes and synchronize configuration', {timeout:20000}, async t=>{
  const {root}=await fixture(t);
  async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
  const platformPort=await port(),runtimePort=await port(),hostPort=await port();
  const settings=deploymentConfiguration({credentials,origin:'https://identity.example.test',dataDir:root});
  Object.assign(settings.platform,{DENTITY_CONTROL_PLANE_PORT:String(platformPort),DENTITY_RUNTIME_SERVICE_URL:`http://127.0.0.1:${runtimePort}`,DENTITY_RUNTIME_HOST_URL:`http://127.0.0.1:${hostPort}`});
  Object.assign(settings.runtime,{DENTITY_RUNTIME_SERVICE_PORT:String(runtimePort),DENTITY_PLATFORM_CONFIG_URL:`http://127.0.0.1:${platformPort}`,DENTITY_PLATFORM_CONFIG_POLL_INTERVAL_MS:'100',DENTITY_RUNTIME_HOST_URL:`http://127.0.0.1:${hostPort}`,DENTITY_MAINTENANCE_ENABLED:'false'});
  Object.assign(settings.host,{DENTITY_RUNTIME_HOST_PI_PORT:String(hostPort),DENTITY_PLATFORM_RESOLVER_URL:`http://127.0.0.1:${runtimePort}/internal/runtime`});
  const children=[];let diagnostics='';
  t.after(async()=>{await Promise.all(children.map(async child=>{if(child.exitCode!==null)return;const done=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await done;clearTimeout(timer);}));});
  for(const [scope,entry] of [['platform','apps/control-plane/dist/main.js'],['runtime','apps/control-plane/dist/runtime-main.js'],['host','apps/runtime-host-pi/dist/main.js']]){
    const file=path.join(root,scope+'.env');await fs.writeFile(file,environmentText(settings[scope]),{mode:0o600});
    const child=spawn(process.execPath,[path.join(repositoryRoot,entry)],{cwd:root,env:{PATH:process.env.PATH,HOME:root,...await protectedEnvironment(file)},stdio:['ignore','pipe','pipe']});children.push(child);child.stderr.on('data',d=>diagnostics+=String(d));
  }
  for(const [p,service] of [[platformPort,'platform'],[runtimePort,'interaction-task'],[hostPort,'runtime-host-pi']]){
    let ready=false;
    for(let i=0;i<100;i++){
      assert.ok(children.every(child=>child.exitCode===null),diagnostics);
      const result=await fetch(`http://127.0.0.1:${p}/readyz`).then(r=>r.json()).catch(()=>null);
      if(result?.status==='ready'){assert.equal(result.service,service);ready=true;break;}
      await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(ready,true,diagnostics);
  }
  const registration=await fetch(`http://127.0.0.1:${platformPort}/api/auth/register`,{method:'POST',headers:{origin:settings.platform.DENTITY_APP_ORIGIN,'content-type':'application/json'},body:JSON.stringify({username:'isolated-start-owner',password:'Synthetic startup password! 246'})});
  assert.equal(registration.status,201,await registration.clone().text());assert.match(registration.headers.get('set-cookie'),/__Host-dentity_session=.*; Secure/);
  await assertStorageOwnership(settings.platformDatabase,settings.runtimeDatabase);
  const monitor=await fetch(`http://127.0.0.1:${hostPort}/internal/monitor/status`,{headers:{authorization:'Bearer '+settings.platform.DENTITY_PI_MONITOR_TOKEN}});
  assert.equal(monitor.status,200);assert.equal((await monitor.json()).counts.executions,0);
});
