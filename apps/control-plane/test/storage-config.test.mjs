import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { resolveStoragePaths } from '../dist/storage-config.js';

test('entry defaults use the home state tree and expand tilde regardless of old directories', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const base = await mkdtemp(path.join(os.tmpdir(), 'identale-storage-defaults-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const checkout = path.join(base, 'checkout'), home = path.join(base, 'home');
  await mkdir(checkout); await mkdir(home);
  const module = new URL('../dist/storage-config.js', import.meta.url).href;
  const script = `import {defaultDatabasePath, defaultSkillResourceRoot, resolveStoragePaths} from ${JSON.stringify(module)};console.log(JSON.stringify({platform:defaultDatabasePath('platform'),runtime:defaultDatabasePath('runtime'),skills:defaultSkillResourceRoot(),custom:resolveStoragePaths({databasePath:'~/custom/p.sqlite',builtinRecordRoot:'~/custom/records'})}));`;
  const run = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, env: { HOME: home }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const expected = {
    platform: path.join(home, '.identale/platform/platform.sqlite'), runtime: path.join(home, '.identale/runtime/runtime.sqlite'), skills: path.join(home, '.identale/resources/skills'),
    custom: { databasePath: path.join(home, 'custom/p.sqlite'), builtinRecordRoot: path.join(home, 'custom/records') },
  };
  assert.deepEqual(run(), expected);
  await mkdir(path.join(checkout, '.dentity/platform'), { recursive: true });
  await writeFile(path.join(checkout, '.dentity/platform/platform.sqlite'), 'synthetic path sentinel');
  await mkdir(path.join(home, '.identity/resources/skills'), { recursive: true });
  assert.deepEqual(run(), expected);
});

test('record root is anchored beside resolved database, not the working directory', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dentity-storage-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'database', 'platform.sqlite');
  assert.deepEqual(resolveStoragePaths({ databasePath }), { databasePath, builtinRecordRoot: path.join(dir, 'database', 'builtin-records') });
  const relative = path.relative(process.cwd(), databasePath);
  assert.deepEqual(resolveStoragePaths({ databasePath: relative }), resolveStoragePaths({ databasePath }));
  assert.equal(resolveStoragePaths({ databasePath, builtinRecordRoot: path.join(dir, 'records') }).builtinRecordRoot, path.join(dir, 'records'));
});

test('storage configuration rejects memory and empty paths without opening a database', () => {
  for (const databasePath of [':memory:', '', ' ']) assert.throws(() => resolveStoragePaths({ databasePath }), /persistent SQLite/);
  assert.throws(() => resolveStoragePaths({ builtinRecordRoot: '' }), /nonempty/);
  assert.throws(() => resolveStoragePaths({ builtinRecordRoot: ' ' }), /nonempty/);
});

test('server creates and reuses the database-adjacent journal after restart', async t => {
  const { createServer } = await import('../dist/server.js');
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dentity-storage-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'database', 'platform.sqlite');
  const options = { databasePath, pollIntervalMs: 60_000 };
  const first = createServer(options);
  await first.ready();
  const manifestPath = path.join(dir, 'database', 'builtin-records', 'owner.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(typeof manifest.hostId, 'string');
  assert.equal(typeof manifest.ownerId, 'string');
  await first.close();
  const second = createServer(options);
  try {
    await second.ready();
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);
  } finally { await second.close(); }
});

test('server honors explicit builtin root without creating the default root', async t => {
  const { createServer } = await import('../dist/server.js');
  const { stat } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dentity-storage-override-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const builtinRecordRoot = path.join(dir, 'custom-records');
  const server = createServer({ databasePath: path.join(dir, 'db', 'platform.sqlite'), builtinRecordRoot, pollIntervalMs: 60_000 });
  try {
    await server.ready();
    assert.equal((await stat(path.join(builtinRecordRoot, 'owner.json'))).isFile(), true);
    await assert.rejects(stat(path.join(dir, 'db', 'builtin-records')), { code: 'ENOENT' });
  } finally { await server.close(); }
});

test('main reports legacy storage clearly without modifying the old database', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFile, stat } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dentity-storage-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE conversation_messages (id TEXT, text TEXT); INSERT INTO conversation_messages VALUES ('message', 'private-synthetic-body');");
  db.close();
  const before = await readFile(databasePath);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url))], {
    cwd: dir,
    env: { PATH: process.env.PATH, DENTITY_DATABASE_PATH: databasePath },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Legacy conversation storage detected/);
  assert.match(result.stderr, /Configure a new database and journal root/);
  assert.equal(result.stderr.includes('private-synthetic-body'), false);
  assert.deepEqual(await readFile(databasePath), before);
  await assert.rejects(stat(path.join(dir, 'builtin-records')), { code: 'ENOENT' });
});

test('a copied database cannot share a journal through a different SQLite write lock', async t => {
  const { createServer } = await import('../dist/server.js');
  const { copyFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dentity-storage-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'original.sqlite');
  const builtinRecordRoot = path.join(dir, 'records');
  const original = createServer({ databasePath, builtinRecordRoot, pollIntervalMs: 60_000 });
  await original.ready();
  await original.close();
  const copiedPath = path.join(dir, 'copied.sqlite');
  await copyFile(databasePath, copiedPath);
  const copied = createServer({ databasePath: copiedPath, builtinRecordRoot, pollIntervalMs: 60_000 });
  try { await assert.rejects(copied.ready(), /another database|invalid ownership/); }
  finally { await copied.close(); }
  await copied.close();
  const recovered=createServer({databasePath:copiedPath,builtinRecordRoot:path.join(dir,'recovered-records'),pollIntervalMs:60000});try{await recovered.ready();}finally{await recovered.close();}
});
