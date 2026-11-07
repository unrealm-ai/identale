import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createPlatform } from '../dist/server.js';
import { ARTICLE_CONTENT, ARTICLE_STEER_MARKER, ARTICLE_STEER_READY, ARTICLE_STEER_CONTINUE } from '../../mock-model/dist/scenarios/default.js';

function refuseBusinessCallbacks(t,app){let reverse=0;app.addHook('onRequest',async(request,reply)=>{if(request.url.startsWith('/internal/runtime/')){reverse++;return reply.code(503).send({error:'reverse_business_access_forbidden'});}});t.after(()=>assert.equal(reverse,0,'Host must never request business resolvers, including assets and output'));}
const origin = 'http://127.0.0.1:15173';
const hostToken = 'dentity-isolated-host-test-token-00000000001', resolverToken = 'dentity-isolated-resolver-test-token-0000001';
async function port() {
  const server = createServer(); await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const value = server.address().port; await new Promise(accept => server.close(accept)); return value;
}
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(accept => setTimeout(accept, 30)); }
  assert.fail('Independent local rule/pi chain did not reach expected state');
}
async function childReady(file, env, url) {
  const child = spawn(process.execPath, [file], { cwd: resolve('.'), env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-4096); });
  try { await until(async () => { if (child.exitCode !== null) assert.fail(`Isolated child exited: ${stderr}`); try { return (await fetch(url)).ok; } catch { return false; } }, 15000); }
  catch (error) { child.kill('SIGTERM'); throw error; }
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(accept => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    child.once('exit', () => { clearTimeout(timer); accept(); });
    child.kill('SIGTERM');
  });
}

test('independent rule service and Host: chat creates authorized task; real pi writes/reads/runs Bash and persists feedback', { timeout: 120000, skip: process.platform !== 'darwin' }, async t => {
  const raw = await mkdtemp(join(tmpdir(), 'dentity-rule-pi-e2e-')), dir = await realpath(raw);
  const executionRoot = join(dir, 'execution'), stateRoot = join(dir, 'host'); await mkdir(executionRoot, { mode: 0o700 });
  const modelPort = await port(), hostPort = await port(), modelOrigin = `http://127.0.0.1:${modelPort}`;
  const tools = ['read', 'write', 'edit', 'bash'];
  const skill = { resourceId: 'article-skill', version: '1', name: 'article-skill', description: 'Synthetic Markdown authoring Skill', content: 'SYNTHETIC_ARTICLE_SKILL_AUTHORIZED: use actual file tools and verify the article.' };
  skill.digest = createHash('sha256').update(skill.content).digest('hex');
  const registryPath = join(dir, 'registry.json');
  await writeFile(registryPath, JSON.stringify({ mcpServers: [], skills: [skill], executionResources: [{ resourceId: 'local-tools', version: '1', mode: 'task', root: executionRoot, tools }] }), { mode: 0o600 });
  let tasks, notifications, platform, host, model, db;
  t.after(async () => { await stop(host); await platform?.close(); await stop(model); db?.close(); await rm(raw, { recursive: true, force: true }); });
  const observationPath = join(dir, 'model-observations.jsonl'), modelEntry = join(dir, 'model-observer.mjs');
  // Trusted test composition observes only synthetic request metadata, without an HTTP debug endpoint.
  await writeFile(modelEntry, `import {appendFileSync} from 'node:fs';import {createServer,closeServer} from ${JSON.stringify(pathToFileURL(resolve('apps/mock-model/dist/server.js')).href)};
const server=createServer({token:'identity-local-test-token',observe(request,ruleId){appendFileSync(${JSON.stringify(observationPath)},JSON.stringify({ruleId,stream:request.stream,tools:request.tools.map(t=>t.name),skillSeen:request.messages.some(m=>['system','developer'].includes(m.role)&&m.content.includes('SYNTHETIC_ARTICLE_SKILL_AUTHORIZED')),supplementSeen:request.messages.some(m=>m.role==='user'&&m.content.includes('SYNTHETIC_PLANNED_SUPPLEMENT')),runningSupplementSeen:request.messages.some(m=>m.role==='user'&&m.content.includes('SYNTHETIC_RUNNING_SUPPLEMENT'))})+'\\n');}});
server.listen(${modelPort},'127.0.0.1');for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void closeServer(server));`, { mode: 0o600 });
  model = await childReady(modelEntry, {}, `${modelOrigin}/readyz`);
  const databasePath = join(dir, 'platform.sqlite');
  platform = createPlatform({ databasePath, origin, pollIntervalMs: 0, onService: value => { tasks = value; },onTaskCompletionNotifications:value=>{notifications=value;},
    runtimeHost: { url: `http://127.0.0.1:${hostPort}`, token: hostToken, resolverToken },
    modelProfiles: { masterKey: Buffer.alloc(32, 73), allowLoopbackHttp: true },
    approvedResources: [{ id: 'local-tools', kind: 'execution', resourceId: 'local-tools', version: '1', tools, shared: true }, { id: 'article-skill', kind: 'skill', resourceId: skill.resourceId, version: skill.version, digest: skill.digest, shared: true }] });
  refuseBusinessCallbacks(t,platform);
  await platform.listen({ host: '127.0.0.1', port: 0 }); const platformOrigin = `http://127.0.0.1:${platform.server.address().port}`;
  host = await childReady('apps/runtime-host-pi/dist/main.js', { DENTITY_RUNTIME_HOST_PI_PORT: String(hostPort), DENTITY_RUNTIME_HOST_TOKEN: hostToken, DENTITY_PLATFORM_RESOLVER_TOKEN: resolverToken,
    DENTITY_PLATFORM_RESOLVER_URL: `${platformOrigin}/internal/runtime`, DENTITY_RUNTIME_HOST_STATE_DIR: stateRoot, DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY: registryPath }, `http://127.0.0.1:${hostPort}/readyz`);
  db = new DatabaseSync(databasePath);
  const request = async (method, path, payload, cookie) => {
    const response = await fetch(platformOrigin + path, { method, headers: { origin, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  };
  const registered = await request('POST', '/api/auth/register', { username: 'isolated-pi-user', password: 'Synthetic isolated real pi test password 2026!' });
  assert.equal(registered.status, 201); const cookie = registered.cookie, workspace = `/api/workspaces/${registered.body.workspace.id}`;
  const employee = await request('POST', `${workspace}/entities`, { name: 'Isolated real pi employee', ownWebUse: true }, cookie);
  assert.equal(employee.status, 200); const base = `${workspace}/entities/${employee.body.entity.id}`;
  const config = { name: 'Explicit local rule configuration', provider: 'openai-compatible', endpoint: `${modelOrigin}/v1`, modelId: 'mock', apiKey: 'identity-local-test-token', bindEntityId: employee.body.entity.id };
  const probe = await request('POST', `${workspace}/model-profiles/test-connection`, config, cookie); assert.equal(probe.status, 200, JSON.stringify(probe.body));
  const saved = await request('POST', `${workspace}/model-profiles`, { ...config, connectionTestReceipt: probe.body.connectionTestReceipt }, cookie); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const capability = await request('POST', `${base}/capability-packages`, { name: 'Authorized article tools and Skill', enabled: true, mode: 'inherit', allowMemberIds: [], denyMemberIds: [], resourceIds: ['local-tools', 'article-skill'] }, cookie);
  assert.equal(capability.status, 200, JSON.stringify(capability.body));
  const conversation = await request('POST', `${base}/conversations`, { operationId: 'real-conversation' }, cookie); assert.equal(conversation.status, 201, JSON.stringify(conversation.body)); const c = conversation.body.conversation;
  const start = await request('POST', `${base}/conversations/${c.id}/turns`, { operationId: 'article-message', text: '帮我写一个md文章' }, cookie); assert.equal(start.status, 202, JSON.stringify(start.body));
  await until(async () => { const state = await request('GET', `${base}/conversations/${c.id}/turns/${start.body.turn.id}`, undefined, cookie); assert.equal(state.status, 200); const turn = state.body.turn; if (['failed', 'unknown'].includes(turn.status)) assert.fail(JSON.stringify(turn)); return turn.status === 'succeeded'; });
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1);
  const task = db.prepare('SELECT * FROM tasks').get();
  assert.ok(JSON.parse(task.config_snapshot_json).skills.some(value => value.resourceId === skill.resourceId));
  assert.equal(JSON.parse(task.config_snapshot_json).executionResources.length, 1);
  try { await until(async () => { await tasks.tick(); const state = db.prepare('SELECT status FROM tasks').get(); if (['failed', 'unknown'].includes(state.status)) { const debug = db.prepare('SELECT * FROM task_updates').all(); assert.fail(JSON.stringify({ state, debug })); } return state.status === 'succeeded'; }); } catch(error) { assert.fail(`${error.message}: ${JSON.stringify({tasks:db.prepare('SELECT status FROM tasks').all(),runs:db.prepare('SELECT status FROM runs').all(),outbox:db.prepare('SELECT status,last_error FROM task_outbox').all()})}`); }
  const run = db.prepare('SELECT * FROM runs').get(); assert.equal(run.status, 'succeeded'); assert.match(run.result, /article\.md/);
  const files = await readdir(executionRoot, { recursive: true }), articles = files.filter(value => value.endsWith('/article.md'));
  assert.equal(articles.length, 1); assert.equal(await readFile(join(executionRoot, articles[0]), 'utf8'), ARTICLE_CONTENT);
  const sessions = await readdir(join(stateRoot, 'sessions'), { recursive: true });
  const transcripts = (await Promise.all(sessions.filter(value => value.endsWith('.jsonl')).map(value => readFile(join(stateRoot, 'sessions', value), 'utf8')))).join('\n');
  for (const name of ['write', 'read', 'bash']) assert.ok(transcripts.includes(`"name":"${name}"`) || transcripts.includes(`"toolName":"${name}"`), `${name} must occur in native pi transcript`);
  const observations = (await readFile(observationPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(observations.some(value => value.stream && value.skillSeen && ['read','write','bash'].every(name => value.tools.includes(name))), 'actual pi model request must contain the authorized Skill and standard tools');
  // A distinct explicit synthetic token keeps this leak assertion meaningful when the public model ID and default token are both mock.
  assert.equal(transcripts.includes('identity-local-test-token'), false); assert.equal(transcripts.includes(hostToken), false);
  const updates = await request('GET', `${base}/conversations/${c.id}/tasks/${task.id}/updates`, undefined, cookie);
  assert.ok(updates.body.updates.some(value => value.type === 'progress')); assert.ok(updates.body.updates.some(value => value.type === 'final_result'));
  const deltas=updates.body.updates.filter(value=>value.type==='output_delta');
  assert.ok(deltas.length>0,'native output deltas remain durable ordered audit events');
  assert.equal(db.prepare("SELECT count(*) AS n FROM deliveries d JOIN task_updates u ON u.task_id=d.task_id AND u.event_id=d.event_id WHERE d.task_id=? AND u.type='output_delta'").get(task.id).n,0,'stream fragments must not become individual business deliveries');
  await until(async()=>{await notifications.tick();return db.prepare("SELECT status FROM task_completion_notifications WHERE task_id=?").get(task.id)?.status==='succeeded';});
  const messages = await request('GET', `${base}/conversations/${c.id}/messages`, undefined, cookie);
  assert.ok(messages.body.messages.some(value => value.id.startsWith('task-notification:') && value.text.includes('article.md')));
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n,1,'notification must never rerun the business task');
  assert.ok(db.prepare('SELECT count(*) AS n FROM deliveries WHERE task_id=? AND text=?').get(task.id,run.result).n >= 2, 'progress and final facts must both remain durable');
  assert.equal(messages.body.messages.filter(value=>value.source==='task_delivery' && value.taskId===task.id && value.text.endsWith(run.result)).length, 0, 'identical progress/final raw feedback is replaced by one model completion report');
  assert.equal((await readFile(observationPath,'utf8')).trim().split('\n').length, observations.length+1, 'reading the persisted feedback projection must not start another interaction model request');
  const query = await request('POST', `${base}/conversations/${c.id}/turns`, { operationId: 'query-finished-task', text: '查询任务进度' }, cookie); assert.equal(query.status,202);
  await until(async()=>{const r=await request('GET',`${base}/conversations/${c.id}/turns/${query.body.turn.id}`,undefined,cookie);if(r.body.turn.status==='failed')assert.fail(JSON.stringify(r.body));if(r.body.turn.status!=='succeeded')return false;assert.match(r.body.turn.text,/succeeded/);assert.match(r.body.turn.text,/article\.md/);return true;});
  const before = files.length;
  const retry = await request('POST', `${base}/conversations/${c.id}/turns`, { operationId: 'article-message', text: '帮我写一个md文章' }, cookie); assert.equal(retry.body.turn.id, start.body.turn.id);
  await tasks.tick(); assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 1); assert.equal((await readdir(executionRoot, { recursive: true })).length, before);
  // Real account/session/package authorization: no model-authored denial can stand in for these checks.
  const bob = await request('POST', '/api/auth/register', { username: 'isolated-second-user', password: 'Second synthetic isolated pi test password!' }); assert.equal(bob.status, 201);
  const invited = await request('POST', `${workspace}/invitations`, { role: 'member' }, cookie); assert.equal(invited.status, 200, JSON.stringify(invited.body));
  const joined = await request('POST', '/api/invitations/accept', { token: invited.body.token }, bob.cookie); assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const bobMember = db.prepare('SELECT id FROM members WHERE workspace_id=? AND user_id=?').get(registered.body.workspace.id, bob.body.user.id).id;
  const ownerMember = registered.body.workspace.memberId;
  const access = await request('PUT', `${base}/web-access`, { allowMemberIds: [ownerMember,bobMember], denyMemberIds: [] }, cookie); assert.equal(access.status, 200, JSON.stringify(access.body));
  const packageConfig = { name: 'Authorized article tools and Skill', enabled: true, mode: 'restrict', allowMemberIds: [ownerMember], denyMemberIds: [], resourceIds: ['local-tools','article-skill'] };
  assert.equal((await request('PUT', `${base}/capability-packages/${capability.body.id}`, packageConfig, cookie)).status, 200);
  const bobConversation = await request('POST', `${base}/conversations`, { operationId: 'bob-conversation' }, bob.cookie); assert.equal(bobConversation.status, 201); const bc = bobConversation.body.conversation;
  assert.equal((await request('GET', `${base}/conversations/${c.id}/messages`, undefined, bob.cookie)).status, 404);
  assert.equal((await request('GET', `${base}/conversations/${bc.id}/tasks/${task.id}`, undefined, bob.cookie)).status, 404);
  const denied = await request('POST', `${base}/conversations/${bc.id}/todos`, { operationId: 'forged-package', input: '帮我写一个md文章', capabilityPackageIds: [capability.body.id] }, bob.cookie);
  assert.equal(denied.status,201,JSON.stringify(denied.body));assert.equal(denied.body.task.run,null);assert.equal((await request('POST',`${base}/conversations/${bc.id}/tasks/${denied.body.task.id}/cancel`,{operationId:'cancel-legacy-request',expectedVersion:1},bob.cookie)).status,200);await tasks.tick();assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n,1);
  assert.equal((await readdir(executionRoot, { recursive: true })).filter(value => value.endsWith('/article.md')).length, 1);
  const granted = { ...packageConfig, allowMemberIds: [ownerMember,bobMember] };
  assert.equal((await request('PUT', `${base}/capability-packages/${capability.body.id}`, granted, cookie)).status, 200);
  const bobStart = await request('POST', `${base}/conversations/${bc.id}/turns`, { operationId: 'bob-article', text: '帮我写一个md文章' }, bob.cookie); assert.equal(bobStart.status, 202);
  await until(async () => { const r = await request('GET', `${base}/conversations/${bc.id}/turns/${bobStart.body.turn.id}`, undefined, bob.cookie); if (r.body.turn.status === 'failed') assert.fail(JSON.stringify(r.body)); return r.body.turn.status === 'succeeded'; });
  const bobTask = db.prepare('SELECT * FROM tasks WHERE user_id=? AND run_id IS NOT NULL').get(bob.body.user.id); assert.ok(bobTask);
  await until(async () => { await tasks.tick(); const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(bobTask.id); if (['failed','unknown'].includes(row.status)) assert.fail(JSON.stringify(row)); return row.status === 'succeeded'; });
  const twoArticles = (await readdir(executionRoot, { recursive: true })).filter(value => value.endsWith('/article.md')); assert.equal(twoArticles.length, 2);
  assert.notEqual(twoArticles[0].split('/')[0],twoArticles[1].split('/')[0]);
  const queued = await request('POST', `${base}/conversations/${bc.id}/tasks`, { operationId: 'queued-before-revocation', input: '帮我写一个md文章', capabilityPackageIds: [capability.body.id] }, bob.cookie); assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const queuedSnapshot=db.prepare('SELECT config_snapshot_json FROM tasks WHERE id=?').get(queued.body.task.id).config_snapshot_json;
  assert.equal((await request('PUT', `${base}/capability-packages/${capability.body.id}`, packageConfig, cookie)).status, 200);
  await tasks.tick();
  assert.equal(db.prepare('SELECT status FROM task_outbox WHERE task_id=? AND kind=?').get(queued.body.task.id,'dispatch').status,'done','already-bound Run dispatches its original snapshot');
  await until(async()=>{await tasks.tick();const row=db.prepare('SELECT status FROM tasks WHERE id=?').get(queued.body.task.id);if(['failed','unknown'].includes(row.status))assert.fail(JSON.stringify(row));return row.status==='succeeded';});
  assert.equal(db.prepare('SELECT config_snapshot_json FROM tasks WHERE id=?').get(queued.body.task.id).config_snapshot_json,queuedSnapshot);
  assert.equal((await readdir(executionRoot, { recursive: true })).filter(value => value.endsWith('/article.md')).length, 3);
  const usable=await request('GET',base+'/usable-capabilities',undefined,bob.cookie);assert.equal(usable.status,200);assert.equal(usable.body.packages.some(p=>p.id===capability.body.id),false,'new execution sessions cannot reacquire the removed package');
  const afterRevoke = await request('GET', `${base}/conversations/${bc.id}/messages`, undefined, bob.cookie); assert.equal(afterRevoke.status, 200);
  const priorTask=await request('GET',`${base}/conversations/${bc.id}/tasks/${queued.body.task.id}`,undefined,bob.cookie);assert.equal(priorTask.status,200);assert.equal(priorTask.body.task.id,queued.body.task.id,'existing authorized task stays readable');
  // A planned task has no Run. Its supplement must reach the actual pi request on start,
  // including the newer revision rather than silently submitting revision one.
  const planned = await request('POST', `${base}/conversations/${c.id}/todos`, { operationId: 'planned-article', input: '帮我写一个md文章', capabilityPackageIds: [capability.body.id] }, cookie);
  assert.equal(planned.status, 201, JSON.stringify(planned.body)); assert.equal(planned.body.task.status, 'planned'); assert.equal(planned.body.task.run, null);
  const plannedId = planned.body.task.id, beforeRuns = db.prepare('SELECT count(*) AS n FROM runs').get().n;
  const supplemented = await request('POST', `${base}/conversations/${c.id}/tasks/${plannedId}/input`, { operationId: 'planned-supplement', expectedVersion: planned.body.task.version, input: 'SYNTHETIC_PLANNED_SUPPLEMENT：请使用 read 和 Bash 核验真实 Markdown 文件。' }, cookie);
  assert.equal(supplemented.status, 200, JSON.stringify(supplemented.body)); assert.equal(supplemented.body.task.run, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, beforeRuns);
  const started = await request('POST', `${base}/conversations/${c.id}/todos/${plannedId}/start`, { operationId: 'start-planned-article', expectedVersion: supplemented.body.task.version }, cookie);
  assert.equal(started.status, 200, JSON.stringify(started.body)); assert.ok(started.body.task.inputRevision > 1);
  await until(async () => { await tasks.tick(); const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(plannedId); if (['failed','unknown'].includes(row.status)) assert.fail(JSON.stringify(row)); return row.status === 'succeeded'; });
  const plannedRun = db.prepare('SELECT result_revision FROM runs WHERE task_id=?').get(plannedId);
  assert.equal(plannedRun.result_revision, started.body.task.inputRevision);
  assert.ok((await readFile(observationPath, 'utf8')).trim().split('\n').map(line=>JSON.parse(line)).some(value=>value.stream && value.skillSeen && value.supplementSeen), 'actual pi request must include the saved planned supplement');
  assert.equal((await readdir(executionRoot, { recursive: true })).filter(value=>value.endsWith('/article.md')).length, 4);

  const slowStart = await request('POST', `${base}/conversations/${c.id}/turns`, { operationId: 'article-with-steer', text: `帮我写一个md文章，${ARTICLE_STEER_MARKER}` }, cookie);
  assert.equal(slowStart.status,202,JSON.stringify(slowStart.body));
  await until(async()=>{const r=await request('GET',`${base}/conversations/${c.id}/turns/${slowStart.body.turn.id}`,undefined,cookie);if(r.body.turn.status==='failed')assert.fail(JSON.stringify(r.body));return r.body.turn.status==='succeeded';});
  const slowTask = db.prepare('SELECT * FROM tasks WHERE input LIKE ?').get(`%${ARTICLE_STEER_MARKER}%`); assert.ok(slowTask);
  let gatePath;
  await until(async()=>{await tasks.tick();gatePath=(await readdir(executionRoot,{recursive:true})).find(value=>value.endsWith(`/${ARTICLE_STEER_READY}`));return !!gatePath;});
  const livePath=`${base}/conversations/${c.id}/tasks/${slowTask.id}`;
  const live=(await request('GET',livePath,undefined,cookie)).body.task;assert.equal(live.status,'running');
  const extra={operationId:'running-supplement',expectedVersion:live.version,input:'SYNTHETIC_RUNNING_SUPPLEMENT：继续核验，不重复生成文件。'};
  const accepted=await request('POST',`${livePath}/input`,extra,cookie);assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.task.inputRevision,2);
  assert.equal((await request('POST',`${livePath}/input`,extra,cookie)).status,200,'same mutation must be idempotent');
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_inputs WHERE task_id=? AND revision=2').get(slowTask.id).n,1);
  let queuedInput;
  await until(async()=>{await tasks.tick();const journal=JSON.parse(await readFile(join(stateRoot,'journal.json'),'utf8'));const execution=journal.executions.find(e=>e.request.payload.execution.target.taskId===slowTask.id);queuedInput=execution?.inputs?.find(p=>p.request.payload.input.taskInput.revision===2);return queuedInput?.receipt.effect==='queued_steer';});
  assert.equal(queuedInput.receipt.status,'received');assert.equal(queuedInput.receipt.evidence,undefined,'blocked tool cannot report input applied');
  assert.equal(db.prepare('SELECT status FROM task_inputs WHERE task_id=? AND revision=2').get(slowTask.id).status,'received');
  const gateDirectory=join(executionRoot,gatePath.slice(0,-ARTICLE_STEER_READY.length));
  await writeFile(join(gateDirectory,ARTICLE_STEER_CONTINUE),'continue\n',{mode:0o600});
  await until(async()=>{await tasks.tick();const state=db.prepare('SELECT status FROM tasks WHERE id=?').get(slowTask.id);if(['failed','unknown'].includes(state.status))assert.fail(JSON.stringify(state));return state.status==='succeeded';});
  assert.equal(db.prepare('SELECT result_revision FROM runs WHERE task_id=?').get(slowTask.id).result_revision,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs WHERE task_id=?').get(slowTask.id).n,1);
  assert.equal(db.prepare('SELECT status FROM task_inputs WHERE task_id=? AND revision=2').get(slowTask.id).status,'applied');
  const finalJournal=JSON.parse(await readFile(join(stateRoot,'journal.json'),'utf8'));const appliedInput=finalJournal.executions.find(e=>e.request.payload.execution.target.taskId===slowTask.id).inputs[0];
  assert.equal(appliedInput.receipt.status,'applied');assert.equal(appliedInput.receipt.evidence.kind,'provider_request');assert.ok(appliedInput.receipt.evidence.messageEntryId);
  assert.ok((await readFile(observationPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).some(value=>value.stream&&value.runningSupplementSeen));
  assert.equal(await readFile(join(gateDirectory,'article.md'),'utf8'),ARTICLE_CONTENT);
});

test('zero extra resources: default local-pi tools write/read/Bash for two isolated authorized users', {timeout:120000,skip:process.platform!=='darwin'},async t=>{
  const raw=await mkdtemp(join(tmpdir(),'dentity-default-pi-')),dir=await realpath(raw),stateRoot=join(dir,'host');
  const modelPort=await port(),hostPort=await port(),modelOrigin=`http://127.0.0.1:${modelPort}`;
  let platform,host,model,db,tasks,notifications;
  t.after(async()=>{await stop(host);await platform?.close();await stop(model);db?.close();await rm(raw,{recursive:true,force:true});});
  model=await childReady('apps/mock-model/dist/main.js',{DENTITY_MOCK_MODEL_PORT:String(modelPort)},`${modelOrigin}/readyz`);
  const databasePath=join(dir,'isolated.sqlite');
  platform=createPlatform({databasePath,origin,pollIntervalMs:0,onService:v=>tasks=v,onTaskCompletionNotifications:v=>notifications=v,
    runtimeHost:{url:`http://127.0.0.1:${hostPort}`,token:hostToken,resolverToken},
    modelProfiles:{masterKey:Buffer.alloc(32,76),allowLoopbackHttp:true}});
  refuseBusinessCallbacks(t,platform);
  await platform.listen({host:'127.0.0.1',port:0});const platformOrigin=`http://127.0.0.1:${platform.server.address().port}`;
  // No resource registry env and no approvedResources/package configuration.
  host=await childReady('apps/runtime-host-pi/dist/main.js',{DENTITY_RUNTIME_HOST_PI_PORT:String(hostPort),DENTITY_RUNTIME_HOST_TOKEN:hostToken,DENTITY_PLATFORM_RESOLVER_TOKEN:resolverToken,DENTITY_PLATFORM_RESOLVER_URL:`${platformOrigin}/internal/runtime`,DENTITY_RUNTIME_HOST_STATE_DIR:stateRoot},`http://127.0.0.1:${hostPort}/readyz`);
  db=new DatabaseSync(databasePath);
  const request=async(method,path,payload,cookie)=>{const r=await fetch(platformOrigin+path,{method,headers:{origin,...(payload===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return{status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],body:await r.json()};};
  const owner=await request('POST','/api/auth/register',{username:'default-tools-owner',password:'Synthetic default tool owner password 2026!'});assert.equal(owner.status,201);
  const bob=await request('POST','/api/auth/register',{username:'default-tools-bob',password:'Synthetic default tool bob password 2026!'});assert.equal(bob.status,201);
  const workspace=`/api/workspaces/${owner.body.workspace.id}`,cookie=owner.cookie;
  const invitation=await request('POST',`${workspace}/invitations`,{role:'member'},cookie);assert.equal(invitation.status,200);
  assert.equal((await request('POST','/api/invitations/accept',{token:invitation.body.token},bob.cookie)).status,200);
  const employee=await request('POST',`${workspace}/entities`,{name:'Default tools employee',ownWebUse:true},cookie);assert.equal(employee.status,200);const base=`${workspace}/entities/${employee.body.entity.id}`;
  const bobMember=db.prepare('SELECT id FROM members WHERE workspace_id=? AND user_id=?').get(owner.body.workspace.id,bob.body.user.id).id;
  assert.equal((await request('PUT',`${base}/web-access`,{allowMemberIds:[owner.body.workspace.memberId,bobMember],denyMemberIds:[]},cookie)).status,200);
  const config={name:'Isolated default tools Mock',provider:'openai-compatible',endpoint:`${modelOrigin}/v1`,modelId:'mock',apiKey:'identity-local-test-token',bindEntityId:employee.body.entity.id};
  const probe=await request('POST',`${workspace}/model-profiles/test-connection`,config,cookie);assert.equal(probe.status,200,JSON.stringify(probe.body));
  assert.equal((await request('POST',`${workspace}/model-profiles`,{...config,connectionTestReceipt:probe.body.connectionTestReceipt},cookie)).status,200);
  const conversations=[];
  for(const [index,actor]of [owner,bob].entries()){
    const c=await request('POST',`${base}/conversations`,{operationId:`defaults-c-${index}`},actor.cookie);assert.equal(c.status,201);conversations.push(c.body.conversation.id);
    const turn=await request('POST',`${base}/conversations/${c.body.conversation.id}/turns`,{operationId:`defaults-article-${index}`,text:'帮我写一个md文章'},actor.cookie);assert.equal(turn.status,202,JSON.stringify(turn.body));
    await until(async()=>{const r=await request('GET',`${base}/conversations/${c.body.conversation.id}/turns/${turn.body.turn.id}`,undefined,actor.cookie);if(['failed','unknown'].includes(r.body.turn.status))assert.fail(JSON.stringify(r.body));return r.body.turn.status==='succeeded';});
    await until(async()=>{await tasks.tick();const task=db.prepare('SELECT * FROM tasks WHERE conversation_id=?').get(c.body.conversation.id);if(!task)return false;if(['failed','unknown'].includes(task.status))assert.fail(JSON.stringify({task,updates:db.prepare('SELECT * FROM task_updates WHERE task_id=?').all(task.id)}));return task.status==='succeeded';});
  }
  const storedTasks=db.prepare('SELECT * FROM tasks').all();assert.equal(storedTasks.length,2);
  for(const task of storedTasks){const config=JSON.parse(task.config_snapshot_json);assert.equal(config.executionResources?.length??0,0);assert.equal(config.skills.length,0);assert.equal(config.mcpServers.length,0);}
  const journal=JSON.parse(await readFile(join(stateRoot,'journal.json'),'utf8')),roots=[];
  for(const execution of journal.executions){const c=execution.request.authorizationContext;const key=createHash('sha256').update(JSON.stringify([c.workspaceId,c.entityId,c.trigger,c.sessionId,c.target])).digest('hex');const directory=join(`${stateRoot}-execution`,key);roots.push(directory);assert.equal(await readFile(join(directory,'article.md'),'utf8'),ARTICLE_CONTENT);}
  assert.equal(new Set(roots).size,2);assert.equal(new Set(journal.executions.map(e=>e.request.authorizationContext.trigger.requester.externalUserId)).size,2);
  const sessions=await readdir(join(stateRoot,'sessions'),{recursive:true});const transcript=(await Promise.all(sessions.filter(v=>v.endsWith('.jsonl')).map(v=>readFile(join(stateRoot,'sessions',v),'utf8')))).join('\n');
  for(const name of ['write','read','bash'])assert.ok(transcript.includes(`"name":"${name}"`)||transcript.includes(`"toolName":"${name}"`));
  for(const other of [owner,bob].entries()){const [index,actor]=other;assert.equal((await request('GET',`${base}/conversations/${conversations[1-index]}/messages`,undefined,actor.cookie)).status,404);}
  await until(async()=>{await notifications.tick();return db.prepare("SELECT count(*) n FROM task_completion_notifications WHERE status='succeeded'").get().n===2;});
  assert.equal(db.prepare('SELECT count(*) n FROM runs').get().n,2);
  t.diagnostic('No registry or packages: two actors, two private task directories, real pi write/read/bash, two authorized completion reports.');
});
