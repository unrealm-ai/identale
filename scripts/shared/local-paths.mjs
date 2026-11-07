// Modified for Identale; see the root NOTICE.
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const localHome = (env = process.env) => path.join(env.HOME || os.homedir(), '.identale');
export function expandLocalPath(value, env = process.env, root = process.cwd()) {
  if (value === '~') return env.HOME || os.homedir();
  if (value.startsWith('~/')) return path.join(env.HOME || os.homedir(), value.slice(2));
  return path.resolve(root, value);
}
export function defaultSecretPath(env = process.env) {
  return path.join(localHome(env), 'local-secrets.json');
}
export function localDatabasePaths(env = process.env, root = process.cwd()) {
  const base = localHome(env);
  return {
    platform: expandLocalPath(env.DENTITY_DATABASE_PATH || path.join(base, 'platform/platform.sqlite'), env, root),
    runtime: expandLocalPath(env.DENTITY_RUNTIME_DATABASE_PATH || path.join(base, 'runtime/runtime.sqlite'), env, root),
  };
}
export function localResourcePaths(env = process.env, root = process.cwd()) {
  return {
    state: expandLocalPath(env.DENTITY_RUNTIME_HOST_STATE_DIR || path.join(localHome(env), 'runtime-host-pi'), env, root),
    skills: expandLocalPath(env.DENTITY_SKILL_RESOURCE_ROOT || path.join(localHome(env), 'resources/skills'), env, root),
  };
}
// Checkouts use separate short paths, even when they share a home directory.
export function localLauncherDirectory(root, env = process.env) {
  return path.join(localHome(env), 'launchers', createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12));
}
export function prepareLauncherDirectory(root, env = process.env) {
  const folder = localLauncherDirectory(root, env);
  const base = localHome(env);
  const directories = [base, path.join(base, 'launchers'), folder];
  for (const directory of directories) {
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('Unsafe local launcher directory; no existing process was stopped.');
  }
  return folder;
}
