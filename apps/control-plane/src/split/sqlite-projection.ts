import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {tableOwner, stripCrossDomainReferences, type StorageOwner} from './table-ownership.js';

export type StoreRole = StorageOwner;
const identifier = '(?:"(?:[^"]|"")*"|`[^`]*`|\\[[^\\]]*\\]|[A-Za-z_][A-Za-z_0-9]*)';
const nameOf = (value: string) => value.replace(/^(?:"|`|\[)|(?:"|`|\])$/g, '').replaceAll('""', '"');
export const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
function ownerOf(name: string): StorageOwner | undefined {
  return tableOwner(name) ?? tableOwner(name.replace(/_(?:principal|planning|trigger)_upgrade$/, ''));
}
/** Only schema statements are redirected. Application values remain bound parameters. */
function statements(sql: string): string[] {
  const out: string[] = []; let start = 0, quote = '', comment = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!, next = sql[i + 1];
    if (comment) { if (comment === '--' && c === '\n') comment = ''; else if (comment === '/*' && c === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) { if (c === quote) { if (next === quote && quote !== ']') i++; else quote = ''; } continue; }
    if (c === '-' && next === '-') { comment = '--'; i++; continue; }
    if (c === '/' && next === '*') { comment = '/*'; i++; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') { quote = c === '[' ? ']' : c; continue; }
    if (c === ';') { out.push(sql.slice(start, i)); start = i + 1; }
  }
  out.push(sql.slice(start)); return out.filter(value => value.trim());
}
export function splitSchemaSql(sql: string, role: StoreRole): string {
  return statements(sql).map(original => {
    const statement = original.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
    const create = statement.match(new RegExp(`^\\s*CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})\\s*\\(`, 'i'));
    if (create) {
      const name = nameOf(create[1]!), owner = ownerOf(name);
      if (!owner) throw new Error(`split_unknown_table:${name}`);
      let rewritten = stripCrossDomainReferences(statement, owner);
      // An unqualified CREATE TABLE ignores a same-name TEMP table. Always use
      // an explicit TEMP declaration for non-owned configuration projections.
      rewritten = rewritten.replace(/CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE/i, owner === role ? 'CREATE TABLE' : 'CREATE TEMP TABLE');
      return rewritten;
    }
    if (/^\s*CREATE\s+(?:(?:TEMP(?:ORARY)?|VIRTUAL)\s+)*TABLE\b/i.test(statement)) throw new Error('split_schema_not_supported');
    const index = statement.match(new RegExp(`^(\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(${identifier})(\\s+ON\\s+)(${identifier})`, 'i'));
    if (index) {
      const name = nameOf(index[4]!), owner = ownerOf(name);
      if (!owner) throw new Error(`split_unknown_table:${name}`);
      if (owner !== role) return statement.replace(index[0], index[1]! + 'temp.' + index[2]! + index[3]! + index[4]!);
    }
    // ALTER ADD COLUMN can also introduce a reference to another ownership domain.
    const alter = statement.match(new RegExp(`^(\\s*ALTER\\s+TABLE\\s+(${identifier})\\s+ADD\\s+(?:COLUMN\\s+)?)([\\s\\S]+)$`, 'i'));
    if (alter) {
      const owner = ownerOf(nameOf(alter[2]!));
      if (!owner) throw new Error(`split_unknown_table:${nameOf(alter[2]!)}`);
      const wrapped = stripCrossDomainReferences(`CREATE TABLE projection(${alter[3]!})`, owner);
      return alter[1]! + wrapped.slice(wrapped.indexOf('(') + 1, wrapped.lastIndexOf(')'));
    }
    return statement;
  }).join(';');
}
function metadataSql(sql: string): string {
  // Explicit main.sqlite_master remains available for storage-boundary audits.
  return sql.replace(/(?<![\w.])sqlite_master\b/gi, '(SELECT * FROM main.sqlite_master UNION ALL SELECT * FROM temp.sqlite_master)');
}
export function projectionDatabase(db: DatabaseSync, role: StoreRole): DatabaseSync {
  return new Proxy(db, {get(target, property) {
    if (property === 'exec') return (sql: string) => target.exec(splitSchemaSql(sql, role));
    if (property === 'prepare') return (sql: string) => target.prepare(metadataSql(sql));
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

export type ConfigurationRows = Record<string, readonly Record<string, SQLInputValue>[]>;
export interface ConfigurationTable {name: string; sql: string; rows: readonly Record<string, SQLInputValue>[]}
/** Replace only validated TEMP configuration projections in one SQLite transaction. */
export function replaceConfigurationTables(db: DatabaseSync, snapshot: ConfigurationRows | readonly ConfigurationTable[]): void {
  if (Array.isArray(snapshot)) {replaceConfigurationCatalog(db, snapshot);return;}
  const rows = snapshot as ConfigurationRows;
  const forbidden = new Set(['credentials', 'sessions', 'invitations', 'feishu_app_registrations']);
  const names = Object.keys(rows);
  for (const name of names) {
    if (tableOwner(name) !== 'platform' || forbidden.has(name)) throw new Error(`snapshot_table_forbidden:${name}`);
    if (!db.prepare("SELECT 1 FROM temp.sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error(`snapshot_schema_missing:${name}`);
    const columns = new Set(db.prepare(`PRAGMA temp.table_info(${quoteIdentifier(name)})`).all().map(row => String(row['name'])));
    for (const row of rows[name]!) for (const column of Object.keys(row)) if (!columns.has(column)) throw new Error(`snapshot_column_unknown:${name}.${column}`);
  }
  db.exec('SAVEPOINT configuration_snapshot');
  try {
    db.exec('PRAGMA defer_foreign_keys=ON');
    for (const name of names) db.exec(`DELETE FROM temp.${quoteIdentifier(name)}`);
    for (const name of names) for (const row of rows[name]!) {
      const keys = Object.keys(row);
      if (!keys.length) throw new Error('snapshot_empty_row');
      db.prepare(`INSERT INTO temp.${quoteIdentifier(name)}(${keys.map(quoteIdentifier).join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]!));
    }
    db.exec('RELEASE configuration_snapshot');
  } catch (error) { db.exec('ROLLBACK TO configuration_snapshot; RELEASE configuration_snapshot'); throw error; }
}

/**
 * Catalog replacement handles columns introduced by service-owned migrations.
 * All schema changes stay TEMP and rollback with their rows. The synchronous
 * foreign-key toggle avoids DROP TABLE cascades on other cached config tables;
 * complete TEMP referential integrity is checked before committing instead.
 */
function replaceConfigurationCatalog(db: DatabaseSync, catalog: readonly ConfigurationTable[]): void {
  const forbidden = new Set(['credentials', 'sessions', 'invitations', 'feishu_app_registrations']);
  if (!db.prepare("SELECT 1 FROM temp.sqlite_master WHERE type='table' AND name='entities'").get()) throw new Error('snapshot_wrong_store');
  if (db.isTransaction) throw new Error('snapshot_nested_catalog_transaction');
  const seen = new Set<string>();
  for (const table of catalog) {
    if (tableOwner(table.name) !== 'platform' || forbidden.has(table.name) || seen.has(table.name)) throw new Error(`snapshot_table_forbidden:${table.name}`);
    const parts = statements(table.sql);
    const create = parts[0]?.match(new RegExp(`^\\s*CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})\\s*\\(`, 'i'));
    if (parts.length !== 1 || !create || nameOf(create[1]!) !== table.name || /--|\/\*|\b(?:ATTACH|DETACH|PRAGMA|VIRTUAL|TRIGGER|LOAD_EXTENSION)\b/i.test(table.sql)) throw new Error('snapshot_schema_invalid');
    // Parse and validate references before any changes, not after a partial apply.
    splitSchemaSql(table.sql, 'runtime');
    seen.add(table.name);
  }
  const indexes: string[] = [];
  for (const table of catalog) indexes.push(...db.prepare("SELECT sql FROM temp.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table.name).map(row => String(row['sql'])));
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']) === 1;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('SAVEPOINT configuration_catalog');
    try {
      for (const table of catalog) db.exec(`DROP TABLE IF EXISTS temp.${quoteIdentifier(table.name)}`);
      for (const table of catalog) db.exec(splitSchemaSql(table.sql, 'runtime'));
      for (const table of catalog) {
        const columns = new Set(db.prepare(`PRAGMA temp.table_info(${quoteIdentifier(table.name)})`).all().map(row => String(row['name'])));
        for (const row of table.rows) {
          const keys = Object.keys(row);
          if (!keys.length) throw new Error('snapshot_empty_row');
          for (const column of keys) if (!columns.has(column)) throw new Error(`snapshot_column_unknown:${table.name}.${column}`);
          db.prepare(`INSERT INTO temp.${quoteIdentifier(table.name)}(${keys.map(quoteIdentifier).join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]!));
        }
      }
      for (const sql of indexes) db.exec(sql);
      if (db.prepare('PRAGMA temp.foreign_key_check').all().length) throw new Error('snapshot_foreign_key_check_failed');
      db.exec('RELEASE configuration_catalog');
    } catch (error) {db.exec('ROLLBACK TO configuration_catalog; RELEASE configuration_catalog');throw error;}
  } finally {db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);}
}
