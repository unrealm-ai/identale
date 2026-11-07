import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultSecretPath, expandLocalPath } from './local-paths.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const within = (root, target) => target === root || target.startsWith(root + path.sep);
export function secretPath(env = process.env) {
  const value = env.DENTITY_LOCAL_SECRETS_PATH;
  const target = value?.startsWith('~/') ? expandLocalPath(value, env) : value || defaultSecretPath(env);
  if (!path.isAbsolute(target)) throw new Error('Local secrets path must be absolute.');
  return path.resolve(target);
}
export function validateMasterKey(value) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').length !== 32 || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new Error('Model master key must be canonical base64 encoding exactly 32 bytes.');
  }
  return value;
}
function validateSecrets(value) {
  if (!value || value.version !== 1) throw new Error('Unsupported local secrets file.');
  validateMasterKey(value.modelMasterKey);
  for (const key of ['runtimeHostToken', 'platformResolverToken']) {
    if (typeof value[key] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value[key])) throw new Error('Invalid local authentication token.');
  }
  if (value.runtimeHostToken === value.platformResolverToken) throw new Error('Local authentication tokens must be distinct.');
  return value;
}
async function checkPath(target, root) {
  const realRoot = await fs.realpath(root);
  if (within(path.resolve(root), target) || within(realRoot, target)) throw new Error('Local secrets must be outside the repository.');
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in the local secrets path.');
      const real = await fs.realpath(current);
      if (within(realRoot, real)) throw new Error('Local secrets must be outside the repository.');
    } catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}
function privateMode(stat, expected, kind) {
  if ((stat.mode & 0o777) !== expected || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Local secrets ${kind} must be owned by the current user with mode ${expected.toString(8)}.`);
  }
}
export async function readSecrets({ env = process.env, platform = process.platform, root = repositoryRoot } = {}) {
  const target = secretPath(env);
  await checkPath(target, root);
  let stat;
  try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (platform === 'win32') throw new Error('Local secrets on Windows require verified ACL protection, which this script does not support.');
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Local secrets must be a regular, non-linked file.');
  privateMode(await fs.stat(path.dirname(target)), 0o700, 'directory');
  privateMode(stat, 0o600, 'file');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    privateMode(opened, 0o600, 'file');
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Local secrets file changed while opening.');
    if (opened.size > 4096) throw new Error('Local secrets file is too large.');
    try { return validateSecrets(JSON.parse(await handle.readFile('utf8'))); }
    catch { throw new Error('Local secrets file is invalid; it was not changed.'); }
  } finally { await handle.close(); }
}
export async function initializeSecrets({ env = process.env, platform = process.platform, root = repositoryRoot, confirmed = false } = {}) {
  if (!confirmed) throw new Error('Explicit confirmation is required to create persistent local secrets.');
  if (platform === 'win32') throw new Error('Local secrets initialization on Windows is unsupported until ACL protection is verified.');
  const target = secretPath(env);
  const existing = await readSecrets({ env, platform, root });
  if (existing) return { path: target, created: false };
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await checkPath(target, root);
  privateMode(await fs.stat(path.dirname(target)), 0o700, 'directory');
  let handle;
  try { handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') { await readSecrets({ env, platform, root }); return { path: target, created: false }; }
    throw error;
  }
  try {
    const value = { version: 1, modelMasterKey: randomBytes(32).toString('base64'), runtimeHostToken: randomBytes(32).toString('base64url'), platformResolverToken: randomBytes(32).toString('base64url') };
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  return { path: target, created: true };
}
