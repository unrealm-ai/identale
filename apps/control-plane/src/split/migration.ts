import {backup, DatabaseSync, type SQLInputValue} from 'node:sqlite';
import {Store} from '../store.js';
import {validateDatabaseVersion} from '../schema-migrations/catalog.js';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync,
  readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readSync, writeSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {tableOwner, stripCrossDomainReferences, type StorageOwner} from './table-ownership.js';

interface SchemaRow {type: string; name: string; tbl_name: string; sql: string | null}
interface FileEvidence {path: string; size: number; sha256: string}
export interface SplitStorageManifest {
  version: 1;
  migrationId: string;
  createdAt: string;
  sourceDatabasePath: string;
  sourceLogicalDigest: string;
  sourceDatabaseId: string | null;
  /** Audit/backup evidence only. Never use this ID to open a migrated runtime journal. */
  legacyJournalOwnerId: string | null;
  journalOwnerSourcePath: string;
  excludedEphemeralRows: readonly string[];
  tables: {name: string; owner: StorageOwner; rows: number}[];
  files: FileEvidence[];
  fileRoots: {id: string; sourcePath: string; destinationPath: string}[];
  operationalJournalRoots: {id: string; backupPath: string; relativePath: string; ownerId: string; hostId: string}[];
}
export interface SplitStorageOptions {
  sourceDatabasePath: string;
  /** A new private directory; never an existing live service directory. */
  destinationDirectory: string;
  /** Operator must stop every legacy application writer before explicitly opting in. */
  confirmOffline: true;
  /** Optional authoritative journals/assets to back up without changing bytes or references. */
  fileRoots?: readonly {id: string; path: string}[];
}
export interface SplitStorageResult {directory: string; platformDatabasePath: string; runtimeDatabasePath: string; manifest: SplitStorageManifest; reused: boolean}

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as unknown as SchemaRow[];
const names = (db: DatabaseSync) => schema(db).filter(r => r.type === 'table');
function privateRegular(path: string) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('split_unsafe_file'); return s; }
function fsync(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function fileEvidence(path: string, root: string): FileEvidence {
  const info = privateRegular(path);
  const h = createHash('sha256'), fd = openSync(path, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let size: number; while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) h.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return {path: relative(root, path), size: info.size, sha256: h.digest('hex')};
}
const isVersionHistory = (name:string) => ['combined','platform','runtime'].some(role=>name===`${role}_schema_migrations`);
function assertKnownSchema(db: DatabaseSync, versioned=false): void {
  for (const item of schema(db)) {
    if (isVersionHistory(item.name)) continue; // Independently validated, never copied as business state.
    if (item.type === 'view' || (item.type === 'trigger' && !versioned)) throw new Error(`split_unsupported_schema:${item.type}:${item.name}`);
    if (!tableOwner(item.type === 'table' ? item.name : item.tbl_name)) throw new Error(`split_unknown_table:${item.tbl_name}`);
    if (item.type === 'table' && (!item.sql || /\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(item.sql))) throw new Error('split_schema_not_supported');
  }
}
/** A deterministic logical digest is stable across SQLite checkpoints and file-page layouts. */
function logicalDigest(db: DatabaseSync): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([db.prepare('PRAGMA user_version').get(), db.prepare('PRAGMA application_id').get()]));
  for (const item of schema(db)) {
    h.update(JSON.stringify(item));
    if (item.type !== 'table') continue;
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(item.sql ?? '');
    const statement = db.prepare(`SELECT ${withoutRowid ? '*' : 'rowid AS __split_rowid__,*'} FROM ${quote(item.name)} ORDER BY ${withoutRowid ? (db.prepare(`PRAGMA table_info(${quote(item.name)})`).all().filter(r => Number(r['pk']) > 0).sort((a,b) => Number(a['pk']) - Number(b['pk'])).map(r => quote(String(r['name']))).join(',')) : 'rowid'}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) h.update(JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? {integer: value.toString()} : value instanceof Uint8Array ? {blob: Buffer.from(value).toString('base64')} : value) + '\n');
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
    const sequences = db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name'); sequences.setReadBigInts(true);
    for (const row of sequences.iterate()) h.update(JSON.stringify([row['name'], String(row['seq'])]));
  }
  return h.digest('hex');
}
function assertOffline(db: DatabaseSync): void {
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (has('runtime_process_owner')) {
    const row = db.prepare('SELECT pid,released FROM runtime_process_owner WHERE id=1').get();
    if (row && row['released'] !== 1) {
      if (!Number.isSafeInteger(row['pid']) || Number(row['pid']) < 1) throw new Error('split_writer_status_unknown');
      try { process.kill(Number(row['pid']), 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return assertLease(); throw new Error('split_writer_status_unknown'); }
      throw new Error('split_source_in_use');
    }
  }
  assertLease();
  function assertLease() {
    if (has('channel_ingress_owner') && db.prepare('SELECT 1 FROM channel_ingress_owner WHERE expires_at>?').get(Date.now())) throw new Error('split_active_ingress_lease');
  }
}
function copyDatabase(source: DatabaseSync, path: string, owner: StorageOwner): {name: string; owner: StorageOwner; rows: number}[] {
  const dest = new DatabaseSync(path);
  chmodSync(path, 0o600);
  const tables = names(source).filter(r => !isVersionHistory(r.name) && tableOwner(r.name) === owner), evidence: {name: string; owner: StorageOwner; rows: number}[] = [];
  try {
    dest.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    for (const table of tables) dest.exec(stripCrossDomainReferences(table.sql!, owner));
    for (const table of tables) {
      const columns = source.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all().filter(c => Number(c['hidden']) === 0).map(c => String(c['name']));
      const rowid = !/\bWITHOUT\s+ROWID\b/i.test(table.sql!) && !columns.some(c => c.toLowerCase() === 'rowid');
      const selected = [...(rowid ? ['rowid'] : []), ...columns];
      const read = source.prepare(`SELECT ${[...(rowid ? ['rowid AS __split_rowid__'] : []), ...columns.map(quote)].join(',')} FROM ${quote(table.name)}`); read.setReadBigInts(true);
      const insert = dest.prepare(`INSERT INTO ${quote(table.name)}(${selected.map(quote).join(',')}) VALUES(${selected.map(() => '?').join(',')})`);
      let rows = 0;
      // Process ownership belongs to the stopped source process, never its replacement.
      if (table.name !== 'runtime_process_owner') for (const row of read.iterate()) { insert.run(...selected.map(c => row[c === 'rowid' && rowid ? '__split_rowid__' : c] as SQLInputValue)); rows++; }
      evidence.push({name: table.name, owner, rows});
    }
    for (const index of schema(source).filter(r => r.type === 'index' && tableOwner(r.tbl_name) === owner && r.sql)) dest.exec(index.sql!);
    if (source.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get() && dest.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
      const sequences = source.prepare('SELECT name,seq FROM sqlite_sequence'); sequences.setReadBigInts(true);
      for (const row of sequences.all()) if (tableOwner(String(row['name'])) === owner) {
        dest.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(row['name'] as string);
        dest.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row['name'] as string, row['seq'] as bigint);
      }
    }
    for (const trigger of schema(source).filter(r => r.type === 'trigger' && tableOwner(r.tbl_name) === owner && r.sql)) dest.exec(trigger.sql!);
    dest.exec('COMMIT; PRAGMA foreign_keys=ON');
    for (const name of ['user_version', 'application_id']) dest.exec(`PRAGMA ${name}=${Number(source.prepare(`PRAGMA ${name}`).get()?.[name] ?? 0)}`);
    if (dest.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok' || dest.prepare('PRAGMA foreign_key_check').get()) throw new Error('split_integrity_failed');
  } finally { dest.close(); }
  fsync(path);
  return evidence;
}
function sourceFileEvidence(root: string): FileEvidence[] {
  const files: FileEvidence[] = [];
  const visit = (path: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('split_symlink_not_supported');
    if (info.isDirectory()) for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    else files.push(fileEvidence(path, root));
  };
  visit(root);
  return files;
}
interface JournalRoot {id: string; metadata: Record<string, unknown> & {version: 1; ownerId: string; hostId: string}}
function journalOwner(databaseId: string | null, sourcePath: string, roots: readonly {id: string; path: string}[]): {id: string | null; path: string; journal?: JournalRoot} {
  let ownerId: string | undefined, ownerPath = sourcePath, journal: JournalRoot | undefined;
  for (const root of roots) {
    const path = join(root.path, 'owner.json');
    if (!existsSync(path)) continue;
    privateRegular(path);
    const metadata: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!metadata || typeof metadata !== 'object' || !('ownerId' in metadata)) continue;
    if (typeof metadata.ownerId !== 'string' || !('version' in metadata) || metadata.version !== 1 || !('hostId' in metadata) || typeof metadata.hostId !== 'string' || !metadata.hostId) throw new Error('split_journal_owner_invalid');
    const identity: unknown = JSON.parse(metadata.ownerId);
    if (!Array.isArray(identity) || identity.length !== 2 || identity[0] !== databaseId || typeof identity[1] !== 'string' || !isAbsolute(identity[1])) throw new Error('split_journal_owner_mismatch');
    if (ownerId && ownerId !== metadata.ownerId) throw new Error('split_journal_owners_conflict');
    if (journal) throw new Error('split_journal_roots_ambiguous');
    ownerId = metadata.ownerId; ownerPath = identity[1];
    journal = {id: root.id, metadata: metadata as JournalRoot['metadata']};
  }
  return {id: ownerId ?? (databaseId ? JSON.stringify([databaseId, sourcePath]) : null), path: ownerPath, ...(journal ? {journal} : {})};
}
function requiredJournalHosts(db: DatabaseSync): Set<string> {
  const hosts = new Set<string>();
  for (const table of names(db).filter(t => tableOwner(t.name) === 'runtime')) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all().map(c => String(c['name'])).filter(name => /json|_ref$|^result$/.test(name));
    if (!columns.length) continue;
    for (const row of db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table.name)}`).iterate()) for (const column of columns) {
      const value = row[column]; if (typeof value !== 'string' || !/^\s*[\[{]/.test(value)) continue;
      let parsed: unknown; try { parsed = JSON.parse(value); } catch { continue; }
      const pending: unknown[] = [parsed];
      while (pending.length) {
        const item = pending.pop(); if (!item || typeof item !== 'object') continue;
        if ('format' in item && item.format === 'dentity-builtin-jsonl' && 'storage' in item && item.storage === 'local' && 'version' in item && item.version === 1 && 'resourceId' in item && typeof item.resourceId === 'string' && 'hostId' in item && typeof item.hostId === 'string') hosts.add(item.hostId);
        for (const child of Object.values(item)) pending.push(child);
      }
    }
  }
  return hosts;
}
function backupFiles(manifest: SplitStorageManifest, id: string): FileEvidence[] {
  const prefix = join('files', id) + sep;
  return manifest.files.filter(file => file.path.startsWith(prefix)).map(file => ({...file, path: file.path.slice(prefix.length)}));
}
function copyFiles(source: string, destination: string, outputRoot: string, evidence: FileEvidence[]) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error('split_symlink_not_supported');
  if (info.isDirectory()) { mkdirSync(destination, {mode: 0o700}); for (const entry of readdirSync(source).sort()) copyFiles(join(source, entry), join(destination, entry), outputRoot, evidence); fsync(destination); }
  else {
    const before = privateRegular(source), read = openSync(source, 'r'), write = openSync(destination, 'wx', 0o600), buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let size: number;
      while ((size = readSync(read, buffer, 0, buffer.length, null)) > 0) { let position = 0; while (position < size) position += writeSync(write, buffer, position, size - position); }
      fsyncSync(write);
    } finally { closeSync(read); closeSync(write); }
    const after = privateRegular(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('split_file_changed');
    const copied = fileEvidence(destination, outputRoot);
    if (copied.sha256 !== fileEvidence(source, dirname(source)).sha256) throw new Error('split_file_changed');
    evidence.push(copied);
  }
}
function validateExisting(directory: string, sourcePath: string, digest: string, roots: readonly {id: string; path: string}[]): SplitStorageManifest {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('split_unsafe_destination');
  const manifestPath = join(directory, 'manifest.json');
  privateRegular(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SplitStorageManifest;
  if (manifest.version !== 1 || manifest.sourceDatabasePath !== sourcePath || manifest.sourceLogicalDigest !== digest || !Array.isArray(manifest.files) || !Array.isArray(manifest.fileRoots) || !Array.isArray(manifest.operationalJournalRoots)) throw new Error('split_destination_conflict');
  if (manifest.fileRoots.length !== roots.length || roots.some(root => !manifest.fileRoots.some(saved => saved.id === root.id && saved.sourcePath === realpathSync(root.path)))) throw new Error('split_file_roots_changed');
  if (new Set(manifest.files.map(f => f.path)).size !== manifest.files.length || ['legacy-backup.sqlite', join('platform', 'platform.sqlite'), join('runtime', 'runtime.sqlite')].some(path => !manifest.files.some(f => f.path === path))) throw new Error('split_manifest_invalid');
  for (const expected of manifest.files) {
    if (isAbsolute(expected.path) || expected.path.split(/[\\/]/).includes('..')) throw new Error('split_manifest_invalid');
    const actual = fileEvidence(join(directory, expected.path), directory);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error('split_output_changed');
  }
  const actualPaths = sourceFileEvidence(directory).map(file => file.path).sort();
  const expectedPaths = [...manifest.files.map(file => file.path), 'manifest.json'].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error('split_destination_changed');
  for (const root of roots) {
    const expected = backupFiles(manifest, root.id);
    if (JSON.stringify(sourceFileEvidence(realpathSync(root.path))) !== JSON.stringify(expected)) throw new Error('split_source_files_changed');
  }
  if (manifest.operationalJournalRoots.length > 1) throw new Error('split_manifest_invalid');
  for (const journal of manifest.operationalJournalRoots) {
    if (journal.relativePath !== join('runtime', 'builtin-records') || journal.backupPath !== join('files', journal.id) || journal.ownerId !== JSON.stringify([manifest.sourceDatabaseId, join(directory, 'runtime', 'runtime.sqlite')])) throw new Error('split_manifest_invalid');
  }
  return manifest;
}

/** Offline-only, never invoked by a normal service startup. Source and existing outputs are immutable. */
export async function splitLegacyStorage(options: SplitStorageOptions): Promise<SplitStorageResult> {
  if (options.confirmOffline !== true) throw new Error('split_offline_confirmation_required');
  const requestedSourcePath = resolve(options.sourceDatabasePath), requestedDirectory = resolve(options.destinationDirectory);
  const sourcePath = realpathSync(requestedSourcePath), directory = join(realpathSync(dirname(requestedDirectory)), basename(requestedDirectory));
  privateRegular(sourcePath);
  if (directory === sourcePath || sourcePath.startsWith(directory + sep)) throw new Error('split_destination_contains_source');
  const roots = options.fileRoots ?? [], ids = new Set<string>();
  for (const root of roots) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(root.id) || ids.has(root.id) || ['platform', 'runtime'].includes(root.id)) throw new Error('split_invalid_file_root');
    ids.add(root.id);
    const resolved = realpathSync(root.path);
    if (lstatSync(root.path).isSymbolicLink()) throw new Error('split_symlink_not_supported');
    if (!lstatSync(resolved).isDirectory()) throw new Error('split_file_root_must_be_directory');
    if (sourcePath.startsWith(resolved + sep)) throw new Error('split_file_root_contains_database');
    if (directory === resolved || directory.startsWith(resolved + sep)) throw new Error('split_destination_inside_file_root');
  }
  const source = new DatabaseSync(sourcePath, {readOnly: true});
  let ownsDirectory = false;
  try {
    const versioned = validateDatabaseVersion(source, 'combined') !== 'unversioned';
    assertOffline(source); assertKnownSchema(source, versioned);
    const initialDigest = logicalDigest(source);
    const initialFileEvidence = roots.map(root => ({id: root.id, files: sourceFileEvidence(realpathSync(root.path))}));
    const result = (manifest: SplitStorageManifest, reused: boolean): SplitStorageResult => ({directory, platformDatabasePath: join(directory, 'platform', 'platform.sqlite'), runtimeDatabasePath: join(directory, 'runtime', 'runtime.sqlite'), manifest, reused});
    if (existsSync(directory)) return result(validateExisting(directory, sourcePath, initialDigest, roots), true);
    mkdirSync(directory, {recursive: false, mode: 0o700}); ownsDirectory = true;
    const backupPath = join(directory, 'legacy-backup.sqlite');
    await backup(source, backupPath); chmodSync(backupPath, 0o600);
    // Finalize our own backup as a standalone SQLite file. Keeping its copied WAL
    // mode would create untracked -wal/-shm files even for later read-only checks.
    const standalone = new DatabaseSync(backupPath);
    try { standalone.exec('PRAGMA journal_mode=DELETE'); } finally { standalone.close(); }
    fsync(backupPath);
    const snapshot = new DatabaseSync(backupPath, {readOnly: true});
    let manifest: SplitStorageManifest;
    try {
      validateDatabaseVersion(snapshot, 'combined');
      assertKnownSchema(snapshot, versioned);
      if (logicalDigest(snapshot) !== initialDigest) throw new Error('split_source_changed');
      const id = names(snapshot).some(t => t.name === 'builtin_storage_metadata') ? snapshot.prepare('SELECT database_id FROM builtin_storage_metadata WHERE id=1').get()?.['database_id'] : null;
      if (names(snapshot).some(t => t.name === 'builtin_records') && typeof id !== 'string') throw new Error('split_journal_owner_missing');
      mkdirSync(join(directory, 'platform'), {mode: 0o700}); mkdirSync(join(directory, 'runtime'), {mode: 0o700});
      const tables = [...copyDatabase(snapshot, join(directory, 'platform', 'platform.sqlite'), 'platform'), ...copyDatabase(snapshot, join(directory, 'runtime', 'runtime.sqlite'), 'runtime')];
      if (versioned) {
        // Histories describe each owning schema, not rows copied from the combined source.
        for (const role of ['platform','runtime'] as const) {
          const path=join(directory,role,`${role}.sqlite`), migrated=new Store(path,{role});migrated.close();
          const finalized=new DatabaseSync(path);try { finalized.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE'); } finally { finalized.close(); }
          fsync(path);
        }
      }
      fsync(join(directory, 'platform')); fsync(join(directory, 'runtime'));
      const files = [fileEvidence(backupPath,directory),...['platform','runtime'].flatMap(role=>sourceFileEvidence(join(directory,role)).map(file=>({...file,path:join(role,file.path)})))];
      const fileRoots: SplitStorageManifest['fileRoots'] = [];
      if (roots.length) mkdirSync(join(directory, 'files'), {mode: 0o700});
      for (const root of roots) { const path = realpathSync(root.path), destinationPath = join('files', root.id); copyFiles(path, join(directory, destinationPath), directory, files); fileRoots.push({id: root.id, sourcePath: path, destinationPath}); }
      const databaseId = typeof id === 'string' ? id : null, owner = journalOwner(databaseId, requestedSourcePath, roots);
      const requiredHosts = requiredJournalHosts(snapshot);
      if ([...requiredHosts].some(host => host !== owner.journal?.metadata.hostId)) throw new Error('split_journal_root_required');
      const operationalJournalRoots: SplitStorageManifest['operationalJournalRoots'] = [];
      if (owner.journal) {
        const journal = owner.journal, backupPath = join('files', journal.id), relativePath = join('runtime', 'builtin-records'), runtimeOwnerId = JSON.stringify([databaseId, join(directory, 'runtime', 'runtime.sqlite')]);
        copyFiles(join(directory, backupPath), join(directory, relativePath), directory, files);
        const ownerPath = join(directory, relativePath, 'owner.json');
        writeFileSync(ownerPath, JSON.stringify({...journal.metadata, ownerId: runtimeOwnerId}), {mode: 0o600}); fsync(ownerPath); fsync(dirname(ownerPath));
        files[files.findIndex(file => file.path === relative(directory, ownerPath))] = fileEvidence(ownerPath, directory);
        operationalJournalRoots.push({id: journal.id, backupPath, relativePath, ownerId: runtimeOwnerId, hostId: journal.metadata.hostId});
      }
      if (roots.length) fsync(join(directory, 'files'));
      fsync(join(directory, 'runtime'));
      manifest = {version: 1, migrationId: randomUUID(), createdAt: new Date().toISOString(), sourceDatabasePath: sourcePath, sourceLogicalDigest: initialDigest, sourceDatabaseId: databaseId, legacyJournalOwnerId: owner.id, journalOwnerSourcePath: owner.path, excludedEphemeralRows: ['runtime_process_owner'], tables, files, fileRoots, operationalJournalRoots};
    } finally { snapshot.close(); }
    assertOffline(source);
    if (logicalDigest(source) !== initialDigest) throw new Error('split_source_changed');
    for (const root of roots) {
      const expected = backupFiles(manifest, root.id);
      if (JSON.stringify(initialFileEvidence.find(saved => saved.id === root.id)?.files) !== JSON.stringify(expected) || JSON.stringify(sourceFileEvidence(realpathSync(root.path))) !== JSON.stringify(expected)) throw new Error('split_source_files_changed');
    }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600, flag: 'wx'}); fsync(join(directory, 'manifest.json')); fsync(directory);
    ownsDirectory = false;
    return result(manifest, false);
  } finally { source.close(); if (ownsDirectory) rmSync(directory, {recursive: true, force: true}); }
}
