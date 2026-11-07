import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutionResource, taskExecutionResource } from '../dist/execution-resources.js';
import { createPiSession } from '../dist/pi-session.js';

const isMac = process.platform === 'darwin';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dentity-standard-tools-test-')));
  const directory = join(base, 'work'); await mkdir(directory, { mode: 0o700 });
  const state = join(base, 'private-state'); await mkdir(state, { mode: 0o700 });
  const sentinel = join(base, 'outside.txt'); await writeFile(sentinel, 'OUTSIDE_SYNTHETIC_SENTINEL');
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, directory, state, sentinel, resource: { resourceId: 'test-local-tools', version: '1', mode: 'task', root: directory, directory, tools: ['read','write','edit','bash'] } };
}
const content = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
test('execution resources are explicit, version-bound, role-bound and never infer permission from a Skill', async t => {
  const f = await fixture(t), registered = { ...f.resource }; delete registered.directory;
  const spec = { role: 'execution', executionResources: [{ resourceId: registered.resourceId, version: '1', tools: ['read'] }] };
  assert.equal(resolveExecutionResource({ role: 'execution', skills: ['anything'] }, [registered]), undefined);
  assert.deepEqual(resolveExecutionResource(spec, [registered]).tools, ['read']);
  for (const changed of [ { ...spec, role: 'interaction' }, { ...spec, executionResources: [{ ...spec.executionResources[0], version: '2' }] }, { ...spec, executionResources: [spec.executionResources[0], spec.executionResources[0]] }, { ...spec, executionResources: [{ ...spec.executionResources[0], tools: ['powershell'] }] } ]) assert.throws(() => resolveExecutionResource(changed, [registered]));
  assert.throws(() => resolveExecutionResource(spec, [{ ...registered, mode: 'project' }]), /Project.*not supported/);
  const context = { workspaceId: 'w', entityId: 'e', trigger: { kind: 'human_request', requester: { externalUserId: 'u' } }, sessionId: 's', target: { kind: 'task_run', taskId: 't', runId: 'r' } };
  const selected = taskExecutionResource(registered, context, f.state);
  assert.notEqual(selected.directory, registered.root);
  assert.notEqual(taskExecutionResource(registered, { ...context, sessionId: 'other' }, f.state).directory, selected.directory);
  assert.throws(() => taskExecutionResource({ ...registered, root: f.base }, context, f.state), /overlaps/);
});

test('local-pi SDK receives native tool schemas and executes real write/read/Bash with an independent cwd', { skip: !isMac }, async t => {
  const f = await fixture(t), bodies = [], before = [];
  const plan = [ ['write', { path: 'article.md', content: '# Real artifact\n' }], ['read', { path: 'article.md' }], ['bash', { command: 'test -f article.md && printf verified > verified.txt' }] ];
  const server = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body); const step = plan[bodies.length - 1];
    const delta = step ? { tool_calls: [{ index: 0, id: `call-${bodies.length}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { content: 'Real tools completed.' };
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'synthetic-local', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk(delta) + chunk({}, step ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const created = await createPiSession({ spec: { role: 'execution', platformTools: [], mcpServers: [], skills: [] }, context: {}, instructions: 'Use approved standard tools only.', prompt: 'Create and verify a synthetic article.', profile: { provider: 'openai-compatible', modelId: 'synthetic-local', apiKey: 'identity-local-test-token', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, sessionDirectory: f.state, resume: false, mcpServers: [], skills: [], executionResource: f.resource }, undefined, async name => { before.push(name); });
  try { await created.session.prompt('Write article.'); assert.equal(created.session.getLastAssistantText(), 'Real tools completed.'); }
  finally { created.session.dispose(); await created.closeMcp(); }
  assert.deepEqual(before, ['write','read','bash']); assert.equal(await readFile(join(f.directory, 'verified.txt'), 'utf8'), 'verified');
  assert.equal(await readFile(join(f.directory, 'article.md'), 'utf8'), '# Real artifact\n');
  assert.deepEqual(bodies[0].tools.map(t => t.function.name).sort(), ['bash','edit','read','write']);
  assert.equal(bodies[1].messages.some(m => m.role === 'tool'), true);
});
