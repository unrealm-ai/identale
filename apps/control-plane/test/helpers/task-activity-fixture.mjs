import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../dist/server.js';
import { Store } from '../../dist/store.js';
import { SqliteConversationRepository } from '../../dist/adapters/sqlite/conversation-repository.js';
import { SqliteTaskRepository } from '../../dist/adapters/sqlite/task-repository.js';
import { JsonlJournal } from '@dentity/runtime-builtin';
export async function taskActivityFixture(t, origin = 'http://127.0.0.1:5173', extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'identity-task-activity-')), path = join(dir, 'isolated.sqlite');
  let modelCalls = 0, service;
  const app = createServer({ ...extra, databasePath: path, origin, pollIntervalMs: 0, onService: value => { service = value; }, modelClient: { async complete() { modelCalls++; throw Error('Task read tests must not call models'); } } });
  await app.ready();
  const store = new Store(path), repo = new SqliteTaskRepository(store);
  const journal = new JsonlJournal({ root: join(dir, 'builtin-records'), ownerId: JSON.stringify([store.databaseId, store.databasePath]), serialize: fn => store.transaction(fn) });
  const conversations = new SqliteConversationRepository(store, journal);
  const call = (method, url, body, cookie) => app.inject({ method, url, ...(body === undefined ? {} : { payload: body }), headers: { origin, ...(cookie ? { cookie } : {}) } });
  async function register(username) { const result = await call('POST', '/api/auth/register', { username, password: 'Synthetic password 2026!' }); assert.equal(result.statusCode, 201, result.body); return { ...result.json(), cookie: String(result.headers['set-cookie']).split(';')[0] }; }
  const owner = await register('activity-owner'), member = await register('activity-member'), admin = await register('activity-admin'), outsider = await register('activity-outsider'), workspaceId = owner.workspace.id;
  store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('activity-member',?,?,'member','active')", workspaceId, member.user.id);
  store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('activity-admin',?,?,'admin','active')", workspaceId, admin.user.id);
  const base = `/api/workspaces/${workspaceId}`, entity = (await call('POST', `${base}/entities`, { name: '任务详情验证员工', ownWebUse: true }, owner.cookie)).json().entity;
  const entityBase = `${base}/entities/${entity.id}`;
  await call('PUT', `${entityBase}/web-access`, { allowMemberIds: [owner.workspace.memberId, 'activity-member'], denyMemberIds: [] }, owner.cookie);
  function conversation(id, user = owner) { const scope = { workspaceId, entityId: entity.id, userId: user.user.id }; conversations.create(id, scope, `activity:${id}`, 1000, 'real', 0); return { id, scope }; }
  const own = conversation('activity-own'), other = conversation('activity-other'), privateConversation = conversation('activity-private', member);
  function seedTask(id, c = own, status = 'succeeded', input = `任务 ${id}`, at = 1000) {
    const scope = { ...c.scope, conversationId: c.id };
    if (status === 'planned') repo.insertPlannedTask(id, scope, id, 'fixture', input, 'new', '[]', '[]', null, at);
    else {
      repo.insertTask(id, scope, c.id, id, 'fixture', input, 'new', 'snapshot', '[]', JSON.stringify(c.scope), 'run:' + id, at, at);
      repo.insertRun('run:' + id, id, 'session:' + id, at); repo.setRunStatus(status, 'run:' + id, at + 100); repo.setTaskStatus(status, at + 100, id);
      repo.insertInitialInput(id, 1, 'input:' + id, input);
    }
    return { id, runId: status === 'planned' ? null : 'run:' + id, root: `${entityBase}/conversations/${c.id}/tasks/${id}/activity`, adminRoot: `${base}/task-management/task-list/${id}/activity` };
  }
  function event(task, type, payload = {}, at) {
    const runId = task.runId, sequence = (store.one('SELECT MAX(sequence) AS n FROM task_updates WHERE run_id=?', runId)?.n ?? 0) + 1;
    const value = { eventId: `${runId}:${sequence}`, runId, sequence, type, ...payload };
    repo.insertUpdate(task.id, runId, value.eventId, sequence, type, JSON.stringify(value), at ?? 1000 + sequence); repo.setRunSequence(sequence, runId);
    return { ...value, id: String(store.one('SELECT id FROM task_updates WHERE run_id=? AND sequence=?', runId, sequence).id) };
  }
  const close = async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); };
  if (t) t.after(close);
  return { app, store, repo, conversations, service, owner, member, admin, outsider, base, entityBase, entity, own, other, privateConversation, seedTask, event, call, close, get modelCalls() { return modelCalls; } };
}
