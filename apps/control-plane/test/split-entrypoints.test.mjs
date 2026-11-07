import {PROTOCOL_VERSION} from '@dentity/contracts';
import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{createServer}from'node:net';
import {existsSync} from 'node:fs';
async function freePort(){const socket=createServer();await new Promise((r,j)=>{socket.once('error',j);socket.listen(0,'127.0.0.1',r);});const port=socket.address().port;await new Promise(r=>socket.close(r));return port;}
async function stop(child){if(child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),8000);await done;clearTimeout(timeout);}
for(const {origin,secureCookies,label} of [
 {origin:'http://127.0.0.1:15198',secureCookies:undefined,label:'default local HTTP'},
 {origin:'https://identity.example.test',secureCookies:'true',label:'external HTTPS with secure cookies'},
])test(`actual platform and runtime entry processes boot separate stores without giving platform PI execution credentials: ${label}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'identity-split-entry-')),platformPort=await freePort(),runtimePort=await freePort(),configToken='synthetic-config-token-'.repeat(3),serviceToken='synthetic-service-token-'.repeat(3),platformUrl='http://127.0.0.1:'+platformPort;
 const env={PATH:process.env.PATH,HOME:root,DENTITY_APP_ORIGIN:origin,DENTITY_PLATFORM_CONFIG_TOKEN:configToken,DENTITY_RUNTIME_SERVICE_TOKEN:serviceToken,...(secureCookies===undefined?{}:{DENTITY_SECURE_COOKIES:secureCookies})};
 const platform=spawn(process.execPath,[resolve('apps/control-plane/dist/main.js')],{env:{...env,DENTITY_DATABASE_PATH:join(root,'platform','platform.sqlite'),DENTITY_CONTROL_PLANE_PORT:String(platformPort),DENTITY_RUNTIME_SERVICE_URL:'http://127.0.0.1:'+runtimePort,DENTITY_RUNTIME_HOST_URL:'http://127.0.0.1:29999',DENTITY_PI_MONITOR_TOKEN:'synthetic-monitor-only-token-'.repeat(3)},stdio:['ignore','pipe','pipe']});
 const runtime=spawn(process.execPath,[resolve('apps/control-plane/dist/runtime-main.js')],{env:{...env,DENTITY_RUNTIME_DATABASE_PATH:join(root,'runtime','runtime.sqlite'),DENTITY_RUNTIME_SERVICE_PORT:String(runtimePort),DENTITY_PLATFORM_CONFIG_URL:platformUrl,DENTITY_PLATFORM_CONFIG_POLL_INTERVAL_MS:'100',DENTITY_MAINTENANCE_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
 let diagnostics='';for(const child of[platform,runtime])child.stderr.on('data',d=>diagnostics+=String(d));t.after(async()=>{await Promise.all([stop(runtime),stop(platform)]);await rm(root,{recursive:true,force:true});});
 for(let n=0;n<200;n++){if(platform.exitCode!==null||runtime.exitCode!==null)assert.fail(diagnostics);const ready=await fetch('http://127.0.0.1:'+runtimePort+'/readyz').then(r=>r.status).catch(()=>0);if(ready===200)break;await new Promise(r=>setTimeout(r,50));}
 const health=await fetch(platformUrl+'/healthz');assert.equal(health.status,200,diagnostics);assert.equal((await health.json()).protocolVersion,PROTOCOL_VERSION);assert.equal((await fetch('http://127.0.0.1:'+runtimePort+'/readyz')).status,200,diagnostics);
 const registration=await fetch(platformUrl+'/api/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'entry-owner',password:'Synthetic entrypoint password!'})});assert.equal(registration.status,201,await registration.clone().text());const actor=await registration.json(),cookie=registration.headers.get('set-cookie').split(';')[0],base='/api/workspaces/'+actor.workspace.id;
 assert.equal(/;\s*Secure(?:;|$)/i.test(registration.headers.get('set-cookie')),secureCookies==='true');
 assert.equal(cookie.startsWith('__Host-dentity_session='),secureCookies==='true');
 const entity=await fetch(platformUrl+base+'/entities',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({name:'Entry point employee',ownWebUse:true})});assert.equal(entity.status,200,await entity.clone().text());const id=(await entity.json()).entity.id;
 let result;for(let n=0;n<100;n++){result=await fetch(platformUrl+base+'/entities/'+id+'/runtime-status',{headers:{cookie}}).then(r=>r.json());if(result.employee)break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(result.status,'available',JSON.stringify(result));assert.equal(result.employee.interaction.configured,false);assert.deepEqual(result.employee.channels,[]);
 const runtimeUrl='http://127.0.0.1:'+runtimePort+base+'/entities/'+id+'/conversations';
 const untrusted=await fetch(runtimeUrl,{method:'POST',headers:{origin,'content-type':'application/json',authorization:'Bearer '+serviceToken},body:'{}'});
 assert.equal(untrusted.status,401);assert.equal((await untrusted.json()).error,'actor_required');
 const wrongOrigin=await fetch(runtimeUrl,{method:'POST',headers:{origin:'https://wrong.example.test','content-type':'application/json',authorization:'Bearer '+serviceToken},body:'{}'});
 assert.equal(wrongOrigin.status,403);assert.equal((await wrongOrigin.json()).error,'invalid_origin');
});

for(const secureCookies of [undefined,'false'])test(`runtime entry rejects external HTTPS without secure cookies: ${secureCookies??'unset'}`,{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'identity-insecure-entry-')),database=join(root,'runtime.sqlite');
 const child=spawn(process.execPath,[resolve('apps/control-plane/dist/runtime-main.js')],{env:{PATH:process.env.PATH,HOME:root,DENTITY_APP_ORIGIN:'https://identity.example.test',DENTITY_PLATFORM_CONFIG_URL:'http://127.0.0.1:29999',DENTITY_PLATFORM_CONFIG_TOKEN:'synthetic-config-token-'.repeat(3),DENTITY_RUNTIME_SERVICE_TOKEN:'synthetic-service-token-'.repeat(3),DENTITY_RUNTIME_SERVICE_PORT:String(await freePort()),DENTITY_RUNTIME_DATABASE_PATH:database,...(secureCookies===undefined?{}:{DENTITY_SECURE_COOKIES:secureCookies})},stdio:['ignore','pipe','pipe']});
 let diagnostics='';child.stderr.on('data',d=>diagnostics+=String(d));
 t.after(async()=>{await stop(child);await rm(root,{recursive:true,force:true});});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 assert.equal(code,1,diagnostics);assert.match(diagnostics,/Unable to start runtime service/);assert.equal(existsSync(database),false);
});
