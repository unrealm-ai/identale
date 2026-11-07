#!/usr/bin/env node
// Modified for Identale; see the root NOTICE.
// Explicit offline maintenance only. Normal local:start never calls this tool.
const usage = `Split an offline legacy identity SQLite database into separate platform/runtime stores.

  node scripts/maintenance/split-storage-migrate.mjs --source <legacy.sqlite> --destination <NEW directory> --confirm-offline [--files <id=directory> ...]

Stop every process writing the legacy database and authoritative files before running.
No source is modified. The new private directory contains a consistent legacy backup,
platform/platform.sqlite, runtime/runtime.sqlite, optional byte-for-byte file backups
under files/<id>, and manifest.json. A validated JSONL root also gets a working copy
at runtime/builtin-records: only its owner.json binds to the new runtime database,
while its hostId, message bytes and references remain unchanged. Supply the actual
journal with --files when the database contains JSONL references; missing or ambiguous
journal roots are rejected. Never run the new runtime against the old journal root.
It does not activate services, delete the source, or copy credential master keys.
Existing destinations are only accepted as a verified
no-op replay of the same completed migration. Keep the backup and existing master key
private for rollback. operationalJournalRoots in the manifest identifies the prepared
working root; legacyJournalOwnerId is backup evidence, never a runtime owner override.
Other copied file roots still require explicit reachable resource configuration.
`;
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(usage); return; }
  let sourceDatabasePath, destinationDirectory, confirmOffline = false;
  const fileRoots = [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--confirm-offline' && !confirmOffline) { confirmOffline = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw Error('invalid_arguments');
    if (argument === '--source' && !sourceDatabasePath) sourceDatabasePath = value;
    else if (argument === '--destination' && !destinationDirectory) destinationDirectory = value;
    else if (argument === '--files' && value.includes('=')) { const at = value.indexOf('='); fileRoots.push({id: value.slice(0, at), path: value.slice(at + 1)}); }
    else throw Error('invalid_arguments');
  }
  if (!sourceDatabasePath || !destinationDirectory || !confirmOffline) throw Error('source_destination_and_offline_confirmation_required');
  const {splitLegacyStorage} = await import('../../apps/control-plane/dist/split/migration.js');
  const result = await splitLegacyStorage({sourceDatabasePath, destinationDirectory, confirmOffline, fileRoots});
  process.stdout.write(JSON.stringify({migrationId: result.manifest.migrationId, directory: result.directory, reused: result.reused, tableCount: result.manifest.tables.length, fileCount: result.manifest.files.length}) + '\n');
}
main().catch(error => { process.stderr.write(`Migration not activated: ${error instanceof Error ? error.message : 'unknown_error'}\n`); process.exitCode = 1; });
