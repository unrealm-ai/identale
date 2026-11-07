import test from 'node:test';
import assert from 'node:assert/strict';
import { taskActivityFixture } from './helpers/task-activity-fixture.mjs';
const get = (f, url, user = f.owner) => f.call('GET', url, undefined, user.cookie);
test('activity projects only public task facts, joins adjacent reply deltas, and retains real times and final result', async t => {
  const f = await taskActivityFixture(t), task = f.seedTask('timeline');
  f.event(task, 'status', { status: 'running', thinking: 'PRIVATE_THINKING', credentials: 'PRIVATE_CREDENTIAL' });
  f.event(task, 'progress', { text: '公开执行进展', thinking: 'PRIVATE_THINKING' }, 2000);
  f.event(task, 'output_delta', { text: '回复' }, 3000); f.event(task, 'output_delta', { text: '片段' }, 3001);
  f.event(task, 'input_receipt', { inputRevision: 1, inputStatus: 'applied' }, 4000);
  f.event(task, 'final_result', { text: '最终回复', inputRevision: 1 }, 5000);
  f.event(task, 'thinking', { text: 'HIDDEN_THINKING_TEXT' }); f.event(task, 'tool_call', { text: 'RAW_TOOL_ARGUMENTS' });
  f.repo.setRunResult('最终回复', 1, task.runId, 1);
  const response = await get(f, task.root); assert.equal(response.statusCode, 200, response.body);
  const page = response.json(); assert.equal(page.runs.length, 1); assert.equal(page.runId, task.runId);
  assert.deepEqual(page.entries.map(e => e.type), ['status', 'progress', 'reply', 'input_receipt', 'final_result']);
  assert.equal(page.entries[2].text, '回复片段'); assert.equal(page.entries[1].createdAt, 2000); assert.equal(page.entries[4].inputRevision, 1);
  assert.doesNotMatch(response.body, /PRIVATE_|HIDDEN_|RAW_TOOL|payload_json|snapshot|source_json|session_id|thinkingSignature/);
  const managed = await get(f, task.adminRoot, f.admin); assert.equal(managed.statusCode, 200, managed.body); assert.deepEqual(managed.json(), page); assert.equal(f.modelCalls, 0);
});
test('all activity and lazy content reads keep separate admin and actor/conversation/workspace authorization', async t => {
  const f = await taskActivityFixture(t), own = f.seedTask('own-scope'), privateTask = f.seedTask('private-scope', f.privateConversation);
  const entry = f.event(privateTask, 'progress', { text: 'PRIVATE_TASK_PROGRESS' });
  for (const user of [f.member, f.outsider]) assert.equal((await get(f, own.adminRoot, user)).statusCode, 403);
  assert.equal((await f.call('GET', own.adminRoot)).statusCode, 401);
  for (const user of [f.owner, f.admin]) assert.equal((await get(f, privateTask.root, user)).statusCode, 404);
  const wrongConversation = own.root.replace(f.own.id, f.other.id); assert.equal((await get(f, wrongConversation)).statusCode, 404);
  assert.equal((await get(f, `${own.root}?runId=${privateTask.runId}`)).statusCode, 404);
  assert.equal((await get(f, `${own.root}?runId=${own.runId}&entryId=${entry.id}`)).statusCode, 404);
  assert.equal((await get(f, own.adminRoot.replace(f.owner.workspace.id, f.outsider.workspace.id), f.outsider)).statusCode, 404);
  assert.equal((await get(f, privateTask.adminRoot, f.admin)).statusCode, 200);
  f.store.run("UPDATE members SET status='inactive' WHERE id='activity-admin'"); assert.equal((await get(f, privateTask.adminRoot, f.admin)).statusCode, 403);
  f.store.run("UPDATE members SET status='inactive' WHERE id=?", f.owner.workspace.memberId); assert.equal((await get(f, own.root)).statusCode, 403); assert.equal(f.modelCalls, 0);
});
test('preview and on-demand chunks redact before slicing, preserve Unicode, and omit large result bodies from summary lists', async t => {
  const f = await taskActivityFixture(t), task = f.seedTask('long'), secret = 'SENSITIVE_CREDENTIAL_1234567890';
  const text = '😀'.repeat(1180) + ` api_key=${secret} ` + '中文'.repeat(9000); const entry = f.event(task, 'final_result', { text, inputRevision: 1 }); f.repo.setRunResult(text, 1, task.runId, 1);
  const page = (await get(f, task.root)).json(); assert.equal(Array.from(page.entries[0].text).length, 1200); assert.doesNotMatch(JSON.stringify(page), new RegExp(secret));
  let offset = 0, collected = '', chunks = 0;
  do { const r = await get(f, `${task.root}?runId=${task.runId}&entryId=${entry.id}&offset=${offset}`); assert.equal(r.statusCode, 200, r.body); const body = r.json(); assert.ok(Array.from(body.text).length <= 8000); collected += body.text; offset = body.nextOffset; chunks++; } while (offset !== null);
  assert.ok(chunks > 1); assert.equal(collected, text.replace(secret, '[redacted]')); assert.doesNotMatch(collected, /SENSITIVE_|\ufffd/);
  for (const path of [`${f.entityBase}/conversations/${f.own.id}/tasks?summary=true`, `${f.base}/task-management/task-list?summary=true`]) { const r = await get(f, path); assert.equal(r.statusCode, 200, r.body); assert.doesNotMatch(r.body, /SENSITIVE_|中文中文/); }
});
test('pages are stable within a Run; newest existing Run is default; supplementation stays in the same Run', async t => {
  const f = await taskActivityFixture(t), task = f.seedTask('paged');
  for (let n = 0; n < 65; n++) f.event(task, 'progress', { text: `步骤 ${n}` });
  const first = (await get(f, task.root)).json(); assert.equal(first.entries.length, 50); assert.equal(first.nextAfter, 50);
  f.event(task, 'input_receipt', { inputRevision: 2, inputStatus: 'received' });
  const second = (await get(f, `${task.root}?runId=${task.runId}&after=${first.nextAfter}`)).json(); assert.equal(second.entries.length, 16); assert.equal(second.runs.length, 1); assert.equal(second.nextAfter, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.id)).size, 66);
  f.repo.insertRun('new-run', task.id, 'new-session', 3000); const latest = (await get(f, task.root)).json(); assert.equal(latest.runs.length, 2); assert.equal(latest.runId, 'new-run'); assert.equal(latest.entries.length, 0);
  assert.equal((await get(f, `${task.root}?runId=${task.runId}`)).json().entries.length, 50);
  for (const query of ['after=-1', 'after=no', 'offset=9007199254740992&entryId=1', 'arbitrary=true']) assert.equal((await get(f, `${task.root}?${query}`)).statusCode, 400);
});
test('unstarted tasks and missing final event retain truthful empty and legacy result states', async t => {
  const f = await taskActivityFixture(t), todo = f.seedTask('todo', f.own, 'planned'), result = f.seedTask('stored-result');
  const planned = (await get(f, todo.root)).json(); assert.equal(planned.runId, null); assert.deepEqual(planned.entries, []); assert.deepEqual(planned.runs, []);
  f.repo.setRunResult('已有最终结果', 1, result.runId, 1);
  const page = (await get(f, result.root)).json(); assert.equal(page.entries[0].type, 'final_result'); assert.equal(page.entries[0].id, `result:${result.runId}`); assert.equal(page.entries[0].text, '已有最终结果');
  assert.equal((await get(f, `${result.adminRoot}?entryId=${encodeURIComponent(page.entries[0].id)}`)).json().text, '已有最终结果');
});
test('historical Run lazy content stays bound to its authorized Task and rechecks login and role on every chunk', async t => {
  const f = await taskActivityFixture(t), task = f.seedTask('history-scope'), other = f.seedTask('other-content');
  const old = f.event(task, 'final_result', { text: '旧 Run 的已保存回复', inputRevision: 1 });
  f.repo.insertRun('replacement-run', task.id, 'replacement-session', 5000);
  f.event({ ...task, runId: 'replacement-run' }, 'final_result', { text: '新 Run 的回复', inputRevision: 1 });
  f.store.run('UPDATE tasks SET run_id=? WHERE id=?', 'replacement-run', task.id);
  const query = `?runId=${encodeURIComponent(task.runId)}&entryId=${old.id}&offset=0`;
  for (const [root, user] of [[task.root, f.owner], [task.adminRoot, f.admin]]) { const response = await get(f, root + query, user); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().text, '旧 Run 的已保存回复'); }
  assert.equal((await get(f, task.root + query, f.member)).statusCode, 404);
  assert.equal((await get(f, task.adminRoot + query, f.member)).statusCode, 403);
  assert.equal((await get(f, other.root + query)).statusCode, 404);
  assert.equal((await get(f, `${task.root}?runId=replacement-run&entryId=${old.id}`)).statusCode, 404);
  assert.equal((await get(f, task.root.replace(f.owner.workspace.id, f.outsider.workspace.id) + query, f.outsider)).statusCode, 404);
  const todo = f.seedTask('invalid-empty-query', f.own, 'planned');
  assert.equal((await get(f, `${todo.adminRoot}?after=invalid`)).statusCode, 400);
  f.store.run('UPDATE sessions SET revoked=1 WHERE user_id=?', f.owner.user.id);
  assert.equal((await get(f, task.root + query)).statusCode, 401);
  f.store.run("UPDATE members SET status='inactive' WHERE id='activity-admin'");
  assert.equal((await get(f, task.adminRoot + query, f.admin)).statusCode, 403);
  assert.equal((await get(f, `${todo.adminRoot}?after=invalid`, f.outsider)).statusCode, 403);
});
