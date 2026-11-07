import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {repositoryRoot,initializeSecrets,secretPath} from '../shared/local-secrets.mjs';
const bootstrap=path.join(repositoryRoot,'scripts/shared/bootstrap-node.sh');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'identity-node-bootstrap-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const bin=path.join(root,'bin');await fs.mkdir(bin);
 for(const name of ['uname','curl','tar','gzip','mkdir','rm','rmdir','mktemp','awk','sha256sum','mv','shasum']){
  let file;try{file=execFileSync('/bin/sh',['-c','command -v "$1"','find-tool',name],{encoding:'utf8'}).trim();}catch{continue;}
  // Apple's shasum dispatches by its script path; a symlink in the isolated
  // PATH breaks that dispatch. Execute the real installed script unchanged.
  if(name==='shasum')await fs.writeFile(path.join(bin,name),`#!/bin/sh\nexec '${file.replaceAll("'", "'\\''")}' "$@"\n`,{mode:0o700});
  else await fs.symlink(file,path.join(bin,name));
 }
 const network=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key)));
 return{root,env:{...network,HOME:root,XDG_DATA_HOME:path.join(root,'data'),PATH:bin}};
}
function shell(code,args=[],options={}){return execFileSync('/bin/bash',['-c','set -euo pipefail; source "$1"; shift; '+code,'bootstrap-test',bootstrap,...args],{encoding:'utf8',stdio:'pipe',...options});}
for(const platform of ['darwin','linux'])test(`local bootstrap under umask 022 prepares private credentials on ${platform}`,async t=>{
 const{root,env}=await fixture(t),checkout=path.join(root,'checkout');await fs.mkdir(checkout);
 const base=path.join(root,'.identale/node');
 shell('umask 022; before=$(umask); identity_create_runtime_base "$1" local; test "$(umask)" = "$before"',[base],{env});
 const first=await initializeSecrets({env,platform,root:checkout,confirmed:true});assert.equal(first.created,true);
 const file=secretPath(env),folder=path.dirname(file),before=await fs.readFile(file);
 assert.equal((await fs.stat(folder)).mode&0o777,0o700);assert.equal((await fs.stat(base)).mode&0o777,0o700);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.equal((await initializeSecrets({env,platform,root:checkout,confirmed:true})).created,false);assert.deepEqual(await fs.readFile(file),before);
});
test('local bootstrap reuses an existing private credential directory without chmod or key rotation',async t=>{
 const{root,env}=await fixture(t),checkout=path.join(root,'checkout');await fs.mkdir(checkout);
 const file=secretPath(env),folder=path.dirname(file),base=path.join(root,'.identale/node');
 await fs.mkdir(folder,{recursive:true,mode:0o700});const initial=await fs.stat(folder);
 shell('umask 022; identity_create_runtime_base "$1" local',[base],{env});
 await initializeSecrets({env,root:checkout,confirmed:true});const before=await fs.readFile(file);
 shell('umask 022; identity_create_runtime_base "$1" local',[base],{env});
 assert.equal((await initializeSecrets({env,root:checkout,confirmed:true})).created,false);
 const after=await fs.stat(folder);assert.equal(after.ino,initial.ino);assert.equal(after.mode,initial.mode);assert.deepEqual(await fs.readFile(file),before);
});
test('local bootstrap never repairs an existing unsafe credential directory or creates secrets there',async t=>{
 const{root,env}=await fixture(t),checkout=path.join(root,'checkout');await fs.mkdir(checkout);
 const file=secretPath(env),folder=path.dirname(file),base=path.join(root,'.identale/node');
 await fs.mkdir(folder,{recursive:true});await fs.chmod(folder,0o755);await fs.mkdir(base,{recursive:true});await fs.chmod(base,0o755);
 shell('umask 022; identity_create_runtime_base "$1" local',[base],{env});
 await assert.rejects(initializeSecrets({env,root:checkout,confirmed:true}),/directory.*mode 700/);
 assert.equal((await fs.stat(folder)).mode&0o777,0o755);assert.equal((await fs.stat(base)).mode&0o777,0o755);await assert.rejects(fs.access(file),{code:'ENOENT'});
});
test('server bootstrap preserves its original directory umask and does not change the caller',async t=>{
 const{root,env}=await fixture(t),base=path.join(root,'server/runtime');
 shell('umask 022; identity_create_runtime_base "$1" server; test "$(umask)" = 0022',[base],{env});
 assert.equal((await fs.stat(base)).mode&0o777,0o755);assert.equal((await fs.stat(path.dirname(base))).mode&0o777,0o755);
});
test('managed-runtime symlink rejection still precedes downloads and credential creation',async t=>{
 const{root,env}=await fixture(t),base=path.join(root,'.identale/node');
 const target=path.join(root,'other');await fs.mkdir(target);await fs.writeFile(path.join(target,'sentinel'),'keep');await fs.mkdir(path.dirname(base),{recursive:true});await fs.symlink(target,base);
 assert.throws(()=>shell('identity_ensure_node local',[],{env}),/must not be symlinks/);
 assert.deepEqual(await fs.readdir(target),['sentinel']);assert.equal(await fs.readFile(path.join(target,'sentinel'),'utf8'),'keep');await assert.rejects(fs.access(secretPath(env)),{code:'ENOENT'});
});
test('compatible installed Node/npm are reused without creating any managed runtime directory',async t=>{
 const{root}=await fixture(t);
 assert.match(shell('identity_ensure_node local; node --version',[],{env:{HOME:root,PATH:process.env.PATH}}),/^v24\./);
 assert.deepEqual(await fs.readdir(root),['bin']);
});
test('archive verification rejects altered archives, missing and ambiguous official entries before extraction',async t=>{
 const{root,env}=await fixture(t);const archive=path.join(root,'archive.tar.gz'),manifest=path.join(root,'SHASUMS256.txt');
 await fs.writeFile(archive,'expected bytes');const hash=createHash('sha256').update('expected bytes').digest('hex');
 await fs.writeFile(manifest,hash+'  node.tar.gz\n');
 shell('identity_verify_node_archive "$1" "$2" node.tar.gz',[archive,manifest],{env});
 await fs.writeFile(archive,'changed bytes');assert.throws(()=>shell('identity_verify_node_archive "$1" "$2" node.tar.gz',[archive,manifest],{env}),/checksum mismatch/);
 await fs.writeFile(manifest,hash+'  wrong.tar.gz\n');assert.throws(()=>shell('identity_verify_node_archive "$1" "$2" node.tar.gz',[archive,manifest],{env}),/missing or ambiguous/);
 await fs.writeFile(manifest,(hash+'  node.tar.gz\n').repeat(2));assert.throws(()=>shell('identity_verify_node_archive "$1" "$2" node.tar.gz',[archive,manifest],{env}),/missing or ambiguous/);
});
test('incomplete managed Node and a concurrent install gate fail without deleting existing files',async t=>{
 const{root,env}=await fixture(t);const system=process.platform==='darwin'?'darwin':'linux',arch=process.arch==='arm64'?'arm64':'x64';
 const base=path.join(root,'.identale/node');
 const destination=path.join(base,`node-v24.19.0-${system}-${arch}`);await fs.mkdir(destination,{recursive:true});
 await fs.writeFile(path.join(destination,'sentinel'),'keep');
 assert.throws(()=>shell('identity_ensure_node local',[],{env}),/incomplete/);
 assert.equal(await fs.readFile(path.join(destination,'sentinel'),'utf8'),'keep');
 await fs.rm(destination,{recursive:true});await fs.mkdir(path.join(base,'.node-install.lock'));
 assert.throws(()=>shell('identity_ensure_node local',[],{env}),/Another Node installation/);
 assert.equal((await fs.stat(path.join(base,'.node-install.lock'))).isDirectory(),true);
});
test('real official Node download, hash validation, local install and second-run reuse', {skip:process.env.DENTITY_TEST_NODE_DOWNLOAD!=='1',timeout:360000},async t=>{
 const{root,env}=await fixture(t);
 const child=spawn('/bin/bash',['-c','set -euo pipefail; source "$1"; identity_ensure_node local; node --version; npm --version; identity_ensure_node local; node --version','bootstrap-test',bootstrap],{env,stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=String(d));child.stderr.on('data',d=>err+=String(d));
 const[code]=await once(child,'exit');assert.equal(code,0,err);assert.equal((out.match(/v24\.19\.0/g)||[]).length,2);
 const base=path.join(root,'.identale/node');
 assert.equal((await fs.readdir(base)).length,1);assert.equal((await fs.readdir(root)).includes('.config'),false);
});

test('missing base tools fail before creating an installation directory',async t=>{
 const{root,env}=await fixture(t);await fs.unlink(path.join(env.PATH,'curl'));
 assert.throws(()=>shell('identity_ensure_node local',[],{env}),/required base tool.*curl/);
 assert.deepEqual(await fs.readdir(root),['bin']);
});

test('skip-install rejects missing Node before downloads or runtime directory creation',async t=>{
 const{root,env}=await fixture(t);
 assert.throws(()=>shell('identity_ensure_node local true',[],{env}),/skip-install forbids downloading/);
 assert.deepEqual(await fs.readdir(root),['bin']);
});
test('public --no-install rejects missing Node before any download or initialization',async t=>{
 const{root,env}=await fixture(t),checkout=path.join(root,'checkout');
 await fs.mkdir(path.join(checkout,'scripts/shared'),{recursive:true});
 await fs.copyFile(path.join(repositoryRoot,'scripts/start.sh'),path.join(checkout,'scripts/start.sh'));
 await fs.copyFile(bootstrap,path.join(checkout,'scripts/shared/bootstrap-node.sh'));
 // curl is deliberately absent: reaching the download path would report a
 // missing curl rather than the explicit no-install diagnostic.
 await fs.unlink(path.join(env.PATH,'curl'));
 for(const tool of ['dirname','pwd']) {
  const file=execFileSync('/bin/sh',['-c','command -v "$1"','find-tool',tool],{encoding:'utf8'}).trim();
  if(file.startsWith('/'))await fs.symlink(file,path.join(env.PATH,tool));
 }
 assert.throws(()=>execFileSync('/bin/bash',[path.join(checkout,'scripts/start.sh'),'--no-install','--no-build'],{env,encoding:'utf8',stdio:'pipe'}),/--no-install forbids downloading/);
 await assert.rejects(fs.access(path.join(root,'.identale')),{code:'ENOENT'});
 assert.deepEqual(await fs.readdir(checkout),['scripts']);
});
test('skip-install reuses managed Node/npm under ~/.identale even when absent from PATH',async t=>{
 if(process.versions.node!=='24.19.0'){t.skip('real pinned Node binary is required for the managed-runtime fixture');return;}
 const{root,env}=await fixture(t);const system=process.platform==='darwin'?'darwin':'linux',arch=process.arch==='arm64'?'arm64':'x64';
 const base=path.join(root,'.identale/node');
 const bin=path.join(base,`node-v24.19.0-${system}-${arch}`,'bin');await fs.mkdir(bin,{recursive:true});
 await fs.symlink(process.execPath,path.join(bin,'node'));
 const npm=execFileSync('/bin/sh',['-c','command -v npm'],{encoding:'utf8'}).trim();await fs.symlink(npm,path.join(bin,'npm'));
 const output=shell('identity_ensure_node local true; node --version; npm --version',[],{env});
 assert.match(output,/v24\.19\.0/);assert.equal((await fs.readdir(base)).length,1);
});

test('old managed Node directories are ignored without downloading, moving or deleting files', async t => {
 const {root,env}=await fixture(t);
 const oldPaths=[path.join(root,'Library/Application Support/dentity/runtime'),path.join(env.XDG_DATA_HOME,'dentity/runtime')];
 for(const folder of oldPaths){await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'sentinel'),'keep');}
 assert.throws(()=>shell('identity_ensure_node local true',[],{env}),/skip-install forbids downloading/);
 await assert.rejects(fs.access(path.join(root,'.identale')),{code:'ENOENT'});
 for(const folder of oldPaths)assert.equal(await fs.readFile(path.join(folder,'sentinel'),'utf8'),'keep');
});
