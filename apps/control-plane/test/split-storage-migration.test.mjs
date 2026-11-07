// Modified for Identale; see the root NOTICE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, existsSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {splitLegacyStorage} from '../dist/split/migration.js';
import {PLATFORM_TABLES, RUNTIME_TABLES, tableOwner, stripCrossDomainReferences} from '../dist/split/table-ownership.js';
import {JsonlJournal} from '../../../packages/runtime-builtin/dist/index.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'identity-split-migration-'));
  const sourceDatabasePath = join(root, 'legacy.sqlite'), destinationDirectory = join(root, 'split');
  const db = new DatabaseSync(sourceDatabasePath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE users(id TEXT PRIMARY KEY, secret TEXT NOT NULL);
    CREATE TABLE credentials(user_id TEXT PRIMARY KEY REFERENCES users(id), password_hash TEXT NOT NULL);
    CREATE TABLE entities(id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), entity_id TEXT REFERENCES entities(id));
    CREATE TABLE tasks(id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), user_id TEXT REFERENCES users(id), run_id TEXT UNIQUE, input_revision INTEGER, config_snapshot_json TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), session_id TEXT UNIQUE, status TEXT, result TEXT);
    CREATE TABLE task_inputs(task_id TEXT REFERENCES tasks(id), revision INTEGER, operation_id TEXT, status TEXT, PRIMARY KEY(task_id,revision));
    CREATE TABLE task_outbox(id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES runs(id), status TEXT, input_revision INTEGER);
    CREATE TABLE channel_message_receipts(message_id TEXT PRIMARY KEY, status TEXT, receipt_json TEXT);
    CREATE TABLE builtin_storage_metadata(id INTEGER PRIMARY KEY, database_id TEXT);
    CREATE TABLE builtin_records(key TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE group_live_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, data BLOB);
    CREATE INDEX group_live_scope_test ON group_live_messages(scope,sequence);
    CREATE TABLE runtime_process_owner(id INTEGER PRIMARY KEY, pid INTEGER, released INTEGER);
    CREATE TABLE channel_ingress_owner(id INTEGER PRIMARY KEY, expires_at INTEGER);
    INSERT INTO users VALUES('actor','SYNTHETIC_SECRET'); INSERT INTO credentials VALUES('actor','SYNTHETIC_HASH'); INSERT INTO entities VALUES('employee','Synthetic');
    INSERT INTO conversations VALUES('conversation','actor','employee');
    INSERT INTO tasks VALUES('task','conversation','actor','run',3,'{"capability":"frozen-synthetic"}');
    INSERT INTO runs VALUES('run','task','session','unknown',NULL);
    INSERT INTO task_inputs VALUES('task',3,'append-once','committed');
    INSERT INTO task_outbox VALUES('dispatch','task','run','unknown',3);
    INSERT INTO channel_message_receipts VALUES('message','committed','{"accepted":true}');
    INSERT INTO builtin_storage_metadata VALUES(1,'stable-journal-owner');
    INSERT INTO builtin_records VALUES('record',1,'{"recordRef":{"resourceId":"history.jsonl","hostId":"stable-host","format":"jsonl"}}');
    INSERT INTO group_live_messages(sequence,scope,data) VALUES(81,'scope',x'0102');
    UPDATE sqlite_sequence SET seq=99 WHERE name='group_live_messages';
    INSERT INTO runtime_process_owner VALUES(1,1,1);
    INSERT INTO channel_ingress_owner VALUES(1,0);`);
  const journal = join(root, 'journal'); mkdirSync(journal, {mode: 0o700});
  writeFileSync(join(journal, 'owner.json'), JSON.stringify({version: 1, ownerId: JSON.stringify(['stable-journal-owner', resolve(sourceDatabasePath)]), hostId: 'stable-host'}), {mode: 0o600});
  writeFileSync(join(journal, 'history.jsonl'), '{"id":"record","synthetic":"kept byte-for-byte"}\n', {mode: 0o600});
  t.after(() => { db.close(); rmSync(root, {recursive: true, force: true}); });
  const options = {sourceDatabasePath, destinationDirectory, confirmOffline: true, fileRoots: [{id: 'builtin-records', path: journal}]};
  return {root, db, journal, options};
}

test('offline split preserves committed/unknown Run/input/receipt/journal facts, separates secrets, and records recoverable private backup', async t => {
  const f = setup(t), before = readFileSync(f.options.sourceDatabasePath);
  const result = await splitLegacyStorage(f.options);
  assert.equal(result.reused, false);
  const platform = new DatabaseSync(result.platformDatabasePath), runtime = new DatabaseSync(result.runtimeDatabasePath), backup = new DatabaseSync(join(result.directory, 'legacy-backup.sqlite'));
  t.after(() => { platform.close(); runtime.close(); backup.close(); });
  const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  assert.deepEqual(tables(platform).sort(), ['credentials', 'entities', 'users']);
  assert.ok(tables(runtime).every(name => tableOwner(name) === 'runtime'));
  assert.equal(runtime.prepare('SELECT database_id FROM builtin_storage_metadata').get().database_id, 'stable-journal-owner');
  assert.equal(runtime.prepare('SELECT user_id FROM conversations').get().user_id, 'actor');
  assert.deepEqual({...runtime.prepare('SELECT * FROM task_inputs').get()}, {task_id: 'task', revision: 3, operation_id: 'append-once', status: 'committed'});
  assert.equal(runtime.prepare('SELECT status FROM task_outbox').get().status, 'unknown');
  assert.equal(runtime.prepare('SELECT session_id FROM runs').get().session_id, 'session');
  assert.equal(runtime.prepare('SELECT status FROM channel_message_receipts').get().status, 'committed');
  assert.equal(runtime.prepare('SELECT count(*) n FROM runtime_process_owner').get().n, 0, 'source ownership must not be transplanted');
  assert.equal(runtime.prepare('SELECT rowid FROM tasks').get().rowid, f.db.prepare('SELECT rowid FROM tasks').get().rowid);
  assert.deepEqual([...runtime.prepare('SELECT data FROM group_live_messages').get().data], [1, 2]);
  runtime.prepare("INSERT INTO group_live_messages(scope) VALUES('new')").run();
  assert.equal(runtime.prepare('SELECT max(sequence) n FROM group_live_messages').get().n, 100, 'AUTOINCREMENT high-water mark is retained');
  assert.equal(runtime.prepare('PRAGMA foreign_key_check').get(), undefined);
  assert.ok(runtime.prepare('PRAGMA foreign_key_list(tasks)').all().some(r => r.table === 'conversations'));
  assert.equal(runtime.prepare('PRAGMA foreign_key_list(conversations)').all().length, 0);
  assert.equal(backup.prepare('SELECT secret FROM users').get().secret, 'SYNTHETIC_SECRET');
  assert.deepEqual(readFileSync(f.options.sourceDatabasePath), before, 'read-only migration must not checkpoint or mutate the source file');
  assert.equal(result.manifest.sourceDatabaseId, 'stable-journal-owner');
  assert.equal(result.manifest.legacyJournalOwnerId, JSON.stringify(['stable-journal-owner', result.manifest.journalOwnerSourcePath]));
  assert.deepEqual(readFileSync(join(result.directory, 'files/builtin-records/history.jsonl')), readFileSync(join(f.journal, 'history.jsonl')));
  assert.deepEqual(readFileSync(join(result.directory, 'runtime/builtin-records/history.jsonl')), readFileSync(join(f.journal, 'history.jsonl')));
  for (const file of result.manifest.files) assert.equal(statSync(join(result.directory, file.path)).mode & 0o777, 0o600);
  assert.equal(statSync(result.directory).mode & 0o777, 0o700);
});

test('retry is a verified no-op; modified source, output or incomplete destination are never overwritten', async t => {
  const f = setup(t), first = await splitLegacyStorage(f.options), receipt = readFileSync(join(first.directory, 'manifest.json'));
  const replay = await splitLegacyStorage(f.options);
  assert.equal(replay.reused, true); assert.equal(replay.manifest.migrationId, first.manifest.migrationId);
  assert.deepEqual(readFileSync(join(first.directory, 'manifest.json')), receipt);
  const output = join(first.directory, 'files/builtin-records/history.jsonl'); writeFileSync(output, 'changed');
  await assert.rejects(splitLegacyStorage(f.options), /split_output_changed/);
  assert.equal(readFileSync(output, 'utf8'), 'changed');
  f.db.prepare("UPDATE tasks SET input_revision=4").run();
  await assert.rejects(splitLegacyStorage(f.options), /split_destination_conflict/);
  const other = join(f.root, 'pre-existing'); mkdirSync(other); writeFileSync(join(other, 'user-file'), 'preserve');
  await assert.rejects(splitLegacyStorage({...f.options, destinationDirectory: other}));
  assert.equal(readFileSync(join(other, 'user-file'), 'utf8'), 'preserve');
});

test('explicit offline confirmation, active process and live ingress lease gate migration without changing source', async t => {
  const f = setup(t);
  await assert.rejects(splitLegacyStorage({...f.options, confirmOffline: false}), /offline_confirmation_required/);
  f.db.prepare('UPDATE runtime_process_owner SET pid=?,released=0').run(process.pid);
  await assert.rejects(splitLegacyStorage(f.options), /split_source_in_use/);
  f.db.prepare('UPDATE runtime_process_owner SET released=1').run();
  f.db.prepare('UPDATE channel_ingress_owner SET expires_at=?').run(Date.now() + 60_000);
  await assert.rejects(splitLegacyStorage(f.options), /split_active_ingress_lease/);
  assert.equal(existsSync(f.options.destinationDirectory), false);
});

test('unknown tables, cross-domain triggers and unsafe file aliases fail closed without leaving partial outputs', async t => {
  const f = setup(t);
  f.db.exec('CREATE TABLE unexpected_data(id TEXT)');
  await assert.rejects(splitLegacyStorage(f.options), /split_unknown_table:unexpected_data/);
  f.db.exec('DROP TABLE unexpected_data; CREATE TRIGGER unknown_effect AFTER INSERT ON tasks BEGIN DELETE FROM credentials; END');
  await assert.rejects(splitLegacyStorage(f.options), /split_unsupported_schema:trigger:unknown_effect/);
  f.db.exec('DROP TRIGGER unknown_effect');
  symlinkSync(join(f.journal, 'history.jsonl'), join(f.journal, 'alias.jsonl'));
  await assert.rejects(splitLegacyStorage(f.options), /split_symlink_not_supported/);
  assert.equal(existsSync(f.options.destinationDirectory), false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1);
});

test('schema transformation removes only cross-domain FKs, preserves literals and same-domain constraints', () => {
  const sql = `CREATE TABLE tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE CHECK(length(user_id)>0),conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,note TEXT DEFAULT 'REFERENCES users(id)',CONSTRAINT member FOREIGN KEY(user_id) REFERENCES users(id))`;
  const transformed = stripCrossDomainReferences(sql, 'runtime');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY)'); db.exec(transformed);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(tasks)').all().map(r => r.table), ['conversations']);
    assert.match(transformed, /CHECK\(length\(user_id\)>0\)/);
    assert.match(transformed, /DEFAULT 'REFERENCES users\(id\)'/);
    assert.throws(() => stripCrossDomainReferences('CREATE TABLE tasks(id TEXT REFERENCES unclassified(id))', 'runtime'), /split_unknown_reference/);
  } finally { db.close(); }
  assert.equal(new Set([...PLATFORM_TABLES, ...RUNTIME_TABLES]).size, PLATFORM_TABLES.length + RUNTIME_TABLES.length);
});

test('source WAL rows are included in the consistent backup and large integer/rowid values stay exact', async t => {
  const f = setup(t);
  f.db.prepare('INSERT INTO group_live_messages(sequence,scope) VALUES(?,?)').run(9007199254740993n, 'large');
  const result = await splitLegacyStorage(f.options), runtime = new DatabaseSync(result.runtimeDatabasePath);
  try { const statement = runtime.prepare("SELECT sequence FROM group_live_messages WHERE scope='large'"); statement.setReadBigInts(true); assert.equal(statement.get().sequence, 9007199254740993n); }
  finally { runtime.close(); }
  assert.match(result.manifest.sourceLogicalDigest, /^[a-f0-9]{64}$/);
  const backupDigest = createHash('sha256').update(readFileSync(join(result.directory, 'legacy-backup.sqlite'))).digest('hex');
  assert.equal(result.manifest.files.find(f => f.path === 'legacy-backup.sqlite').sha256, backupDigest);
});

test('a writer changing SQLite while backup is in flight aborts and removes only the new incomplete directory', async t => {
  const f = setup(t), pending = splitLegacyStorage(f.options);
  f.db.prepare('UPDATE tasks SET input_revision=4').run();
  await assert.rejects(pending, /split_source_changed/);
  assert.equal(existsSync(f.options.destinationDirectory), false);
  assert.equal(f.db.prepare('SELECT input_revision FROM tasks').get().input_revision, 4, 'migration never rolls back independent source writes');
});

test('source journal changes during backup or after a completed migration are rejected rather than silently reused', async t => {
  const f = setup(t), pending = splitLegacyStorage(f.options);
  writeFileSync(join(f.journal, 'history.jsonl'), 'different source bytes');
  await assert.rejects(pending, /split_source_files_changed/);
  assert.equal(existsSync(f.options.destinationDirectory), false);
  const result = await splitLegacyStorage(f.options);
  writeFileSync(join(f.journal, 'new.jsonl'), 'new source history');
  await assert.rejects(splitLegacyStorage(f.options), /split_source_files_changed/);
  await assert.rejects(splitLegacyStorage({...f.options, fileRoots: []}), /split_file_roots_changed/);
  assert.equal(result.reused, false);
});

test('ownership catalog covers each persistent CREATE TABLE in current control-plane sources; transient rebuild tables are excluded', () => {
  const sourceRoot = new URL('../src/', import.meta.url), discovered = new Set();
  function scan(root) {
    for (const entry of readdirSync(root, {withFileTypes: true})) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith('.ts')) for (const match of readFileSync(path, 'utf8').matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z_0-9]*)\s*\(/gi)) discovered.add(match[1]);
    }
  }
  scan(sourceRoot);
  // projection is only the synthetic CREATE wrapper used to parse ALTER COLUMN SQL.
  for (const name of discovered) if (!['tasks_planning_upgrade', 'tasks_trigger_upgrade', 'projection'].includes(name)) assert.ok(tableOwner(name), `unclassified persistent table ${name}`);
});

test('offline CLI validates explicit arguments and produces a verified no-op receipt without activating any service', async t => {
  const f = setup(t), run = promisify(execFile);
  const cli = resolve('scripts/maintenance/split-storage-migrate.mjs');
  const help = await run(process.execPath, [cli, '--help']); assert.match(help.stdout, /Stop every process/);
  await assert.rejects(run(process.execPath, [cli, '--source', f.options.sourceDatabasePath, '--destination', f.options.destinationDirectory]), e => e.code === 1 && /offline_confirmation_required/.test(e.stderr));
  const args = [cli, '--source', f.options.sourceDatabasePath, '--destination', f.options.destinationDirectory, '--confirm-offline', '--files', 'builtin-records=' + f.journal];
  const first = JSON.parse((await run(process.execPath, args)).stdout), second = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(first.migrationId, second.migrationId);
  assert.equal(f.db.prepare('SELECT released FROM runtime_process_owner').get().released, 1);
});

test('operational real JSONL keeps host/ref/body bytes but binds exclusively to the new database; original and backup remain untouched', async t => {
  const f = setup(t), ownerId = JSON.stringify(['stable-journal-owner', resolve(f.options.sourceDatabasePath)]), scope = {workspaceId: 'workspace', entityId: 'employee', conversationId: 'conversation'};
  const journal = new JsonlJournal({root: f.journal, ownerId, serialize: fn => fn()});
  const ref = journal.put(scope, 'message', {role: 'user', text: 'Synthetic durable history'});
  f.db.prepare('UPDATE builtin_records SET json=?').run(JSON.stringify({journalRef: ref}));
  const originalOwner = readFileSync(join(f.journal, 'owner.json'));
  const bodyPath = join(ref.location.resourceId, 'current.jsonl'), originalBody = readFileSync(join(f.journal, bodyPath));
  const result = await splitLegacyStorage(f.options), runtime = new DatabaseSync(result.runtimeDatabasePath);
  try {
    const descriptor = result.manifest.operationalJournalRoots[0], workingRoot = join(result.directory, descriptor.relativePath), newOwnerId = JSON.stringify(['stable-journal-owner', result.runtimeDatabasePath]);
    assert.equal(descriptor.relativePath, join('runtime', 'builtin-records')); assert.equal(descriptor.ownerId, newOwnerId); assert.equal(descriptor.hostId, ref.location.hostId);
    const moved = new JsonlJournal({root: workingRoot, ownerId: newOwnerId, serialize: fn => fn()});
    const storedRef = JSON.parse(runtime.prepare('SELECT json FROM builtin_records').get().json).journalRef;
    assert.deepEqual(moved.read(scope, storedRef), {role: 'user', text: 'Synthetic durable history'});
    assert.deepEqual(moved.location(scope), journal.location(scope));
    assert.throws(() => new JsonlJournal({root: workingRoot, ownerId, serialize: fn => fn()}), /belongs to another database/, 'old database cannot write new working root');
    assert.throws(() => new JsonlJournal({root: f.journal, ownerId: newOwnerId, serialize: fn => fn()}), /belongs to another database/, 'new database cannot write original root');
    assert.throws(() => new JsonlJournal({root: join(result.directory, descriptor.backupPath), ownerId: newOwnerId, serialize: fn => fn()}), /belongs to another database/, 'backup cannot be mistaken for operational data');
    assert.deepEqual(readFileSync(join(f.journal, 'owner.json')), originalOwner);
    assert.deepEqual(readFileSync(join(result.directory, descriptor.backupPath, 'owner.json')), originalOwner);
    assert.deepEqual(readFileSync(join(workingRoot, bodyPath)), originalBody);
    assert.deepEqual(readFileSync(join(result.directory, descriptor.backupPath, bodyPath)), originalBody);
    assert.deepEqual(readFileSync(join(f.journal, bodyPath)), originalBody);
    const replay = await splitLegacyStorage(f.options); assert.equal(replay.reused, true);
    writeFileSync(join(workingRoot, 'owner.json'), originalOwner);
    await assert.rejects(splitLegacyStorage(f.options), /split_output_changed/, 'working owner binding is included in the verified receipt');
  } finally { runtime.close(); }
});

test('the actual journal owner header wins over a source path alias, while another database journal is rejected', async t => {
  const f = setup(t), ownerPath = join(f.root, 'original-database-location.sqlite'), ownerId = JSON.stringify(['stable-journal-owner', ownerPath]);
  writeFileSync(join(f.journal, 'owner.json'), JSON.stringify({version: 1, ownerId, hostId: 'stable-host'}));
  const result = await splitLegacyStorage(f.options);
  assert.equal(result.manifest.journalOwnerSourcePath, ownerPath); assert.equal(result.manifest.legacyJournalOwnerId, ownerId);
  writeFileSync(join(f.journal, 'owner.json'), JSON.stringify({version: 1, ownerId: JSON.stringify(['another-database', ownerPath]), hostId: 'other-host'}));
  await assert.rejects(splitLegacyStorage({...f.options, destinationDirectory: join(f.root, 'different-output')}), /split_journal_owner_mismatch/);
  assert.equal(existsSync(join(f.root, 'different-output')), false);
});

test('new destination content is protected, and file roots cannot copy the legacy database into a runtime resource area', async t => {
  const f = setup(t);
  await assert.rejects(splitLegacyStorage({...f.options, fileRoots: [{id: 'unsafe-data-root', path: f.root}]}), /split_file_root_contains_database/);
  const result = await splitLegacyStorage(f.options), extra = join(result.directory, 'runtime', 'runtime.sqlite-wal');
  writeFileSync(extra, 'new uncheckpointed runtime state');
  await assert.rejects(splitLegacyStorage(f.options), /split_destination_changed/);
  assert.equal(readFileSync(extra, 'utf8'), 'new uncheckpointed runtime state');
});

test('actual JSONL references require one matching explicit journal root, never a guessed or empty history', async t => {
  const f = setup(t), journal = new JsonlJournal({root: f.journal, ownerId: JSON.stringify(['stable-journal-owner', resolve(f.options.sourceDatabasePath)]), serialize: fn => fn()});
  const ref = journal.put({workspaceId: 'workspace', entityId: 'employee', conversationId: 'conversation'}, 'message', {text: 'kept'});
  f.db.prepare('UPDATE builtin_records SET json=?').run(JSON.stringify({journalRef: ref}));
  await assert.rejects(splitLegacyStorage({...f.options, fileRoots: []}), /split_journal_root_required/);
  assert.equal(existsSync(f.options.destinationDirectory), false);
  await assert.rejects(splitLegacyStorage({...f.options, fileRoots: [...f.options.fileRoots, {id: 'duplicate-journal', path: f.journal}]}), /split_journal_roots_ambiguous/);
  const oldHeader = JSON.parse(readFileSync(join(f.journal, 'owner.json'), 'utf8'));
  writeFileSync(join(f.journal, 'owner.json'), JSON.stringify({...oldHeader, hostId: 'another-host'}));
  await assert.rejects(splitLegacyStorage(f.options), /split_journal_root_required/);
});
