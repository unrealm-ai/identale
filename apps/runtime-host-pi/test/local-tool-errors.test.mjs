import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTools } from '../dist/local-tools.js';
import { executionResourceFor, taskExecutionResource } from '../dist/execution-resources.js';
import { LocalToolError, nativeToolFailure, parseLocalToolResponse } from '../dist/local-tool-errors.js';

const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
async function fixture(t) {
  const raw = await mkdtemp(join(tmpdir(), 'dentity-local-errors-')), base = await realpath(raw), state = join(base, 'host');
  await mkdir(state, { mode: 0o700 });
  t.after(() => rm(raw, { recursive: true, force: true }));
  const spec = { role: 'execution', executionResources: [] };
  const context = { workspaceId: 'qa-w', entityId: 'qa-e', sessionId: 'qa-session', trigger: { kind: 'human_request', requester: { externalUserId: 'qa-a' } }, target: { kind: 'task_run', taskId: 'qa-task', runId: 'qa-run' } };
  const resource = taskExecutionResource(executionResourceFor(spec, [], state), context, state), unknown = [];
  const local = await createLocalTools(resource, async () => {}, name => unknown.push(name));
  t.after(() => local.close());
  return { resource, unknown, tool: name => local.tools.find(tool => tool.name === name) };
}
const classified = (code, kind = 'tool_failure') => error => {
  assert.ok(error instanceof LocalToolError);
  assert.equal(error.code, code); assert.equal(error.kind, kind);
  assert.equal(error.outcome, kind === 'tool_failure' ? 'failed' : 'unknown');
  assert.ok(error.message.length <= 180);
  assert.doesNotMatch(error.message, /synthetic-secret|private-path|Bearer|\/Users\//);
  return true;
};

test('native failure diagnostics keep bounded types without paths, stack, commands or secrets', () => {
  const secret = 'private-path/Bearer synthetic-secret\n' + 'x'.repeat(10000);
  for (const [errno, code] of [['ENOENT', 'FILE_NOT_FOUND'], ['EACCES', 'ACCESS_DENIED'], ['EPERM', 'ACCESS_DENIED'], ['EISDIR', 'INVALID_FILE_PATH'], ['EROFS', 'READ_ONLY_FILESYSTEM']]) {
    const failure = nativeToolFailure(Object.assign(new Error(secret), { code: errno, path: secret, syscall: secret }), true, true);
    assert.deepEqual(failure, { kind: 'tool_failure', code, errorType: 'Error' });
    assert.throws(() => parseLocalToolResponse(JSON.stringify({ ok: false, error: failure })), classified(code));
    assert.doesNotMatch(JSON.stringify(failure), /synthetic-secret|private-path|Bearer/);
  }
  assert.deepEqual(nativeToolFailure(new TypeError(secret), false), { kind: 'tool_failure', code: 'TOOL_FAILED', errorType: 'TypeError' });
  assert.equal(nativeToolFailure(Object.assign(new Error(secret), { name: secret, code: secret }), false).errorType, 'Error');
  for (const code of ['ENOENT', 'EACCES', 'ENOSPC']) assert.equal(nativeToolFailure(Object.assign(new Error(secret), { code }), true).code, 'TOOL_OUTCOME_UNKNOWN');
});

test('malformed native envelopes are protocol errors, never ordinary file failures', () => {
  const invalid = ['not json', '{}', 'null', '[]', '{"ok":true}', '{"ok":false,"error":"Local native tool failed"}',
    JSON.stringify({ ok: true, result: { content: 'invalid' } }),
    JSON.stringify({ ok: true, result: { content: [null] } }),
    JSON.stringify({ ok: false, error: { code: 'ENOENT', kind: 'tool_failure', errorType: 'Error' } }),
    JSON.stringify({ ok: false, error: { code: 'FILE_NOT_FOUND', kind: 'outcome_unknown', errorType: 'Error' } }),
    JSON.stringify({ ok: false, error: { code: 'FILE_NOT_FOUND', kind: 'tool_failure', errorType: 'synthetic-secret' } }),
    JSON.stringify({ ok: false, error: { code: 'FILE_NOT_FOUND', kind: 'tool_failure', errorType: 'Error', message: 'synthetic-secret' } })];
  for (const raw of invalid) assert.throws(() => parseLocalToolResponse(raw), classified('TOOL_RESPONSE_INVALID', 'protocol_error'));
  const result = { content: [{ type: 'text', text: '保留原生结果' }], details: { original: true }, isError: true };
  assert.deepEqual(parseLocalToolResponse(JSON.stringify({ ok: true, result })), result);
});

test('real SDK missing read and edit files report definite safe failures and keep tools usable', async t => {
  const { resource, unknown, tool } = await fixture(t), path = 'private-path-synthetic-secret.txt';
  await assert.rejects(tool('read').execute('missing-read', { path }), classified('FILE_NOT_FOUND'));
  await assert.rejects(tool('edit').execute('missing-edit', { path, edits: [{ oldText: 'before', newText: 'after' }] }), classified('FILE_NOT_FOUND'));
  assert.deepEqual(unknown, []);
  await tool('write').execute('create', { path: 'readable.txt', content: 'ready' });
  assert.equal(text(await tool('read').execute('read-after-failure', { path: 'readable.txt' })), 'ready');
  assert.equal(await readFile(join(resource.directory, 'readable.txt'), 'utf8'), 'ready');
});

test('real OS permission denials for read, edit and write are safe definite failures', async t => {
  const { resource, unknown, tool } = await fixture(t), path = join(resource.directory, 'private-path-synthetic-secret.txt');
  await writeFile(path, 'before', { mode: 0o600 }); await chmod(path, 0o000);
  try {
    await assert.rejects(tool('read').execute('denied-read', { path }), classified('ACCESS_DENIED'));
    await assert.rejects(tool('edit').execute('denied-edit', { path, edits: [{ oldText: 'before', newText: 'after' }] }), classified('ACCESS_DENIED'));
    await assert.rejects(tool('write').execute('denied-write', { path, content: 'after' }), classified('ACCESS_DENIED'));
    assert.deepEqual(unknown, []);
  } finally { await chmod(path, 0o600); }
  assert.equal(text(await tool('read').execute('restored-read', { path })), 'before');
});

test('SDK validation failures before file mutation do not mark the run unknown', async t => {
  const { resource, unknown, tool } = await fixture(t);
  await writeFile(join(resource.directory, 'article.txt'), 'before');
  await assert.rejects(tool('edit').execute('no-match', { path: 'article.txt', edits: [{ oldText: 'not present', newText: 'after' }] }), classified('TOOL_FAILED'));
  await assert.rejects(tool('read').execute('bad-offset', { path: 'article.txt', offset: 100 }), classified('TOOL_FAILED'));
  assert.deepEqual(unknown, []);
  assert.equal(text(await tool('read').execute('read-original', { path: 'article.txt' })), 'before');
});

test('a normal nonzero Bash exit keeps its native error result, not outcome unknown', async t => {
  const { unknown, tool } = await fixture(t);
  const result = await tool('bash').execute('nonzero', { command: 'printf expected-failure; exit 7' });
  assert.equal(result.isError, true); assert.match(text(result), /Command exited with code 7/);
  assert.deepEqual(unknown, []);
  assert.match(text(await tool('bash').execute('after-nonzero', { command: 'printf next-command' })), /next-command/);
});

test('a real Bash timeout stays unknown, runs only once, and blocks follow-up tools', async t => {
  const { resource, unknown, tool } = await fixture(t);
  await assert.rejects(tool('bash').execute('timeout', { command: 'printf started >> executions.txt; sleep 10; printf late > late.txt', timeout: 0.2 }), classified('TOOL_TIMEOUT', 'outcome_unknown'));
  assert.equal(await readFile(join(resource.directory, 'executions.txt'), 'utf8'), 'started');
  assert.deepEqual(unknown, ['bash']);
  await assert.rejects(tool('write').execute('after-timeout', { path: 'not-run.txt', content: 'must not run' }), classified('TOOL_NOT_ACTIVE'));
  await assert.rejects(readFile(join(resource.directory, 'not-run.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(resource.directory, 'late.txt')), { code: 'ENOENT' });
  assert.deepEqual(unknown, ['bash']);
});

test('Bash output collection failing after side effects remains unknown even with ENOENT', async t => {
  const { resource, unknown, tool } = await fixture(t);
  // Only the command's own isolated TMPDIR spill file is removed. The marker proves
  // the real SDK created the file before its output collector subsequently lost it.
  const command = 'printf effect >> executions.txt; /usr/bin/head -c 100000 /dev/zero | /usr/bin/tr "\\000" x; for i in {1..300}; do for log in "$TMPDIR"/pi-bash-*.log; do if [ -f "$log" ]; then /bin/rm -- "$log"; printf removed > removed.txt; exit 0; fi; done; sleep 0.01; done; exit 9';
  await assert.rejects(tool('bash').execute('lost-output', { command }), classified('TOOL_OUTCOME_UNKNOWN', 'outcome_unknown'));
  assert.equal(await readFile(join(resource.directory, 'executions.txt'), 'utf8'), 'effect');
  assert.equal(await readFile(join(resource.directory, 'removed.txt'), 'utf8'), 'removed');
  assert.deepEqual(unknown, ['bash']);
  await assert.rejects(tool('bash').execute('no-replay', { command: 'printf effect >> executions.txt' }), classified('TOOL_NOT_ACTIVE'));
  assert.equal(await readFile(join(resource.directory, 'executions.txt'), 'utf8'), 'effect');
});
