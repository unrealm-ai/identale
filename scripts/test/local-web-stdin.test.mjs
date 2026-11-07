import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { localLauncherDirectory } from '../shared/local-paths.mjs';
import { childEnvironments } from '../local/local-start.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/id-web-pty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('only Web receives an explicit noninteractive Vite environment', async t => {
  const root = await fixture(t), env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), CI: 'false' };
  const before = { ...env }, children = await childEnvironments(env);
  assert.equal(children.web.CI, 'true');
  for (const name of ['platform', 'runtime', 'host', 'mockModel', 'mockMcp', 'build']) assert.equal(children[name].CI, undefined, name);
  assert.deepEqual(env, before);
});

test('actual Vite survives PTY EOF without readline and retains launcher SIGTERM cleanup', { timeout: 25000 }, async t => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Local process groups require macOS/Linux'); return; }
  if (spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status !== 0) { t.skip('Python3 pty support unavailable for native terminal fixture'); return; }
  const root = await fixture(t), web = path.join(root, 'web.mjs'), launcher = path.join(root, 'launcher.mjs'), driver = path.join(root, 'terminal-driver.py');
  const viteModule = new URL('../../node_modules/vite/dist/node/index.js', import.meta.url).href;
  const launcherModule = new URL('../local/local-start.mjs', import.meta.url).href;
  await fs.writeFile(web, `import {createServer} from ${JSON.stringify(viteModule)};import fs from 'node:fs/promises';
const [root,port]=process.argv.slice(2);const server=await createServer({configFile:false,root,cacheDir:root+'/cache',logLevel:'silent',appType:'custom',server:{host:'127.0.0.1',port:Number(port),strictPort:true}});
server.middlewares.use((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true}));});
await server.listen();server.bindCLIShortcuts();await fs.writeFile(root+'/web-state.json',JSON.stringify({pid:process.pid,stdinIsTTY:!!process.stdin.isTTY,readlinePresent:!!server._shortcutsState,viteStdinExitBound:process.stdin.listeners('end').some(fn=>fn.name==='parentSigtermCallback'),hmrEnabled:server.config.server.hmr!==false,ci:process.env.CI}));`);
  await fs.writeFile(launcher, `import {superviseLocal,childEnvironments} from ${JSON.stringify(launcherModule)};import fs from 'node:fs/promises';import net from 'node:net';
const [root,web]=process.argv.slice(2);const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
const env=await childEnvironments({HOME:root,XDG_CONFIG_HOME:root+'/config',PATH:process.env.PATH});const run=await superviseLocal({cwd:root,commands:[{name:'isolated-web-tty',port,file:process.execPath,args:[web,root,String(port)],env:env.web}],log(){},killAfterMs:1000,timeoutMs:8000});
await fs.writeFile(root+'/launcher-ready.json',JSON.stringify({pid:process.pid,instanceId:run.instance.instance,port,started:run.started}));process.exit(await run.completion);`);
  await fs.writeFile(driver, `import os,pty,subprocess,time,json,pathlib,signal,http.client,socket,sys
root=pathlib.Path(sys.argv[1]);master,slave=pty.openpty();p=None
try:
 with (root/'fixture-output.txt').open('wb') as log:
  p=subprocess.Popen([sys.argv[2],str(root/'launcher.mjs'),str(root),str(root/'web.mjs')],stdin=slave,stdout=log,stderr=log,cwd=root,env={'PATH':'/usr/bin:/bin','HOME':str(root)},start_new_session=True)
  os.close(slave);slave=None;deadline=time.monotonic()+10
  while (not (root/'launcher-ready.json').exists() or not (root/'web-state.json').exists()) and p.poll() is None and time.monotonic()<deadline:time.sleep(.05)
  ready=json.loads((root/'launcher-ready.json').read_text());web=json.loads((root/'web-state.json').read_text())
  assert ready['pid']==p.pid and ready['started']
  assert not web['stdinIsTTY'] and not web['readlinePresent'] and not web['viteStdinExitBound'] and web['ci']=='true' and web['hmrEnabled'],web
  os.close(master);master=None;deadline=time.monotonic()+2;checks=0
  while time.monotonic()<deadline:
   assert p.poll() is None,'launcher unexpectedly exited after PTY loss'
   conn=http.client.HTTPConnection('127.0.0.1',ready['port'],timeout=1);conn.request('GET','/');response=conn.getresponse();assert response.status==200 and json.loads(response.read())['ready'];conn.close();checks+=1;time.sleep(.15)
  p.send_signal(signal.SIGTERM);p.wait(timeout=6);assert p.returncode==143
  rows=[json.loads(line) for line in (pathlib.Path(${JSON.stringify(localLauncherDirectory(root, { HOME: root }))})/'diagnostics'/ (ready['instanceId']+'.jsonl')).read_text().splitlines()]
  assert any(row['event']=='launcher_complete' and row.get('reason')=='signal_SIGTERM' and row.get('cleanupConfirmed') for row in rows)
  assert any(row['event']=='group_clean' and row.get('cleanupConfirmed') for row in rows)
  assert any(row['event']=='command_exit' and row.get('service')=='isolated-web-tty' for row in rows)
  probe=socket.socket();assert probe.connect_ex(('127.0.0.1',ready['port']))!=0;probe.close()
  result={'survivedPtyLoss':True,'httpChecksAfterPtyLoss':checks,'readlinePresent':web['readlinePresent'],'viteStdinExitBound':web['viteStdinExitBound'],'hmrEnabled':web['hmrEnabled'],'launcherExitCode':p.returncode,'cleanupConfirmed':True};(root/'result.json').write_text(json.dumps(result));print(json.dumps(result))
finally:
 if master is not None:os.close(master)
 if slave is not None:os.close(slave)
 if p is not None and p.poll() is None:p.send_signal(signal.SIGTERM);p.wait(timeout=6)
`);
  let output = '';
  const child = spawn('python3', [driver, root, process.execPath], { env: { PATH: process.env.PATH, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0) {
    const ready = JSON.parse(await fs.readFile(path.join(root, 'launcher-ready.json'), 'utf8'));
    output += '\n' + await fs.readFile(path.join(localLauncherDirectory(root, { HOME: root }), 'diagnostics', ready.instanceId + '.jsonl'), 'utf8');
  }
  assert.equal(code, 0, output + '\n' + await fs.readFile(path.join(root, 'fixture-output.txt'), 'utf8').catch(() => ''));
  t.diagnostic(output.trim());
  const result = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
  assert.equal(result.survivedPtyLoss, true); assert.ok(result.httpChecksAfterPtyLoss >= 2);
  assert.equal(result.readlinePresent, false); assert.equal(result.viteStdinExitBound, false);
  assert.equal(result.hmrEnabled, true); assert.equal(result.launcherExitCode, 143); assert.equal(result.cleanupConfirmed, true);
  assert.doesNotMatch(await fs.readFile(path.join(root, 'fixture-output.txt'), 'utf8'), /read EIO|Unhandled 'error'/);
});
