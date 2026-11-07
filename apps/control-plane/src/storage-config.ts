import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const expandHomePath = (value: string): string => value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
export function defaultDatabasePath(role: 'platform' | 'runtime' | 'control-plane'): string {
  const relative = role === 'control-plane' ? 'control-plane.sqlite' : `${role}/${role}.sqlite`;
  return join(homedir(), '.identale', relative);
}
export function defaultSkillResourceRoot(): string {
  return join(homedir(), '.identale/resources/skills');
}

/** Resolve once at startup so subsequent cwd changes cannot relocate stored records. */
export function resolveStoragePaths(options: { databasePath?: string; builtinRecordRoot?: string } = {}): { databasePath: string; builtinRecordRoot: string } {
  const configuredDatabase = expandHomePath(options.databasePath ?? defaultDatabasePath('control-plane'));
  if (!configuredDatabase.trim() || configuredDatabase === ':memory:') throw new Error('A persistent SQLite file path is required');
  const databasePath = resolve(configuredDatabase);
  if (options.builtinRecordRoot !== undefined && !options.builtinRecordRoot.trim()) throw new Error('builtinRecordRoot must be a nonempty directory path');
  return {
    databasePath,
    builtinRecordRoot: options.builtinRecordRoot === undefined ? join(dirname(databasePath), 'builtin-records') : resolve(expandHomePath(options.builtinRecordRoot)),
  };
}
