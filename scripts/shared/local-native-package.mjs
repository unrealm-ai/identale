import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
// Deliberate upgrade gate: changing the dependency lock also requires reviewing
// this official source pin. Neither installed package metadata nor its name is
// authority to run a lifecycle script.
export const ARGON2_PIN = Object.freeze({
  version: '0.45.1',
  resolved: 'https://registry.npmjs.org/argon2/-/argon2-0.45.1.tgz',
  integrity: 'sha512-skm+/WCjkGqCQxF7FG1LuZXM5yvbFjgbfiCGsud2oLgaDhh6b6dbH0b1EkghbM+xx4Bj8Ape+KKgixoIlWZicQ==',
});
const exec = promisify(execFile), archives = new Map();
const digest = data => 'sha512-' + createHash('sha512').update(data).digest('base64');
const validPin = entry => entry && !entry.link && ['version', 'resolved', 'integrity'].every(key => entry[key] === ARGON2_PIN[key]);
async function regular(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8 * 1024 * 1024) throw new Error('non_regular_source');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const now = await handle.stat(); if (now.ino !== before.ino || now.dev !== before.dev || !now.isFile() || now.size > 8 * 1024 * 1024) throw new Error('replaced_source'); return await handle.readFile(); }
  finally { await handle.close(); }
}
function download() {
  return new Promise((resolve, reject) => {
    let done = false, size = 0; const chunks = [];
    const request = get(ARGON2_PIN.resolved, { headers: { accept: 'application/octet-stream' } }, response => {
      if (response.statusCode !== 200) { response.resume(); end(new Error('official_archive_download_failed')); return; }
      response.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) end(new Error('official_archive_too_large')); else chunks.push(chunk); });
      response.on('error', () => end(new Error('official_archive_download_failed')));
      response.on('end', () => end(null, Buffer.concat(chunks)));
    });
    const deadline = setTimeout(() => end(new Error('official_archive_download_deadline')), 15000);
    function end(error, data) { if (done) return; done = true; clearTimeout(deadline); request.destroy(); error ? reject(error) : resolve(data); }
    request.on('error', () => end(new Error('official_archive_download_failed')));
  });
}
async function archive(env, allowDownload) {
  const cache = path.resolve(env.npm_config_cache || path.join(env.HOME || os.homedir(), '.npm'));
  const hex = Buffer.from(ARGON2_PIN.integrity.slice(7), 'base64').toString('hex');
  const file = path.join(cache, '_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  const key = file;
  if (!archives.has(key)) archives.set(key, (async () => {
    const folder = path.join(await fs.realpath(os.tmpdir()), `dentity-native-vendor-${process.getuid()}`);
    try { await fs.mkdir(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('unsafe_archive_cache');
    const cached = path.join(folder, hex + '.tgz');
    let data;
    try { data = await regular(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { data = await regular(cached); }
      catch (missing) { if (missing.code !== 'ENOENT') throw missing; if (!allowDownload) throw new Error('official_archive_not_cached'); data = await download(); }
    }
    if (digest(data) !== ARGON2_PIN.integrity) throw new Error('official_archive_integrity_mismatch');
    try { if (digest(await regular(cached)) !== ARGON2_PIN.integrity) throw new Error('official_archive_integrity_mismatch'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const staging = await fs.mkdtemp(path.join(folder, 'verified-'));
      try { const staged = path.join(staging, 'source.tgz'); await fs.writeFile(staged, data, { flag: 'wx', mode: 0o600 }); await fs.rename(staged, cached); }
      finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    return data;
  })().catch(error => { archives.delete(key); throw error; }));
  return archives.get(key);
}
async function comparePackage(expected, actual, prefix = '') {
  const expectedNames = await fs.readdir(expected), actualNames = await fs.readdir(actual);
  for (const name of actualNames) {
    const relative = prefix + name, installed = path.join(actual, name), stat = await fs.lstat(installed);
    // Native outputs are produced by the reviewed local compiler, not packed
    // vendor source. A linked build root is still refused.
    if (!prefix && name === 'build') { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('linked_native_output'); continue; }
    if (!expectedNames.includes(name) || stat.isSymbolicLink()) throw new Error('unknown_or_linked_package_content');
    const original = path.join(expected, name), source = await fs.lstat(original);
    if (source.isDirectory() && stat.isDirectory()) await comparePackage(original, installed, relative + '/');
    else if (source.isFile() && stat.isFile()) { if (!(await regular(original)).equals(await regular(installed))) throw new Error('package_content_mismatch'); }
    else throw new Error('package_content_type_mismatch');
  }
  if (expectedNames.some(name => !actualNames.includes(name))) throw new Error('missing_package_content');
}
export async function verifyOfficialArgon2({ cwd, env = process.env, allowDownload = false }) {
  let temp;
  try {
    cwd = await fs.realpath(cwd);
    const lock = JSON.parse((await regular(path.join(cwd, 'package-lock.json'))).toString('utf8'));
    const installed = JSON.parse((await regular(path.join(cwd, 'node_modules/.package-lock.json'))).toString('utf8'));
    if (!validPin(lock.packages?.['node_modules/argon2']) || !validPin(installed.packages?.['node_modules/argon2'])) throw new Error('lock_or_install_provenance_mismatch');
    const folder = path.join(cwd, 'node_modules/argon2');
    if ((await fs.lstat(folder)).isSymbolicLink() || await fs.realpath(folder) !== folder) throw new Error('linked_package_location');
    const bytes = await archive(env, allowDownload);
    temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dentity-official-argon2-'));
    const tarball = path.join(temp, 'source.tgz'); await fs.writeFile(tarball, bytes, { mode: 0o600 });
    // Only an archive with the hard-coded official SHA-512 reaches tar.
    await exec('/usr/bin/tar', ['-xzf', tarball, '-C', temp], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 1024 * 1024 });
    const manifest = JSON.parse((await regular(path.join(temp, 'package/package.json'))).toString('utf8'));
    if (manifest.name !== 'argon2' || manifest.version !== ARGON2_PIN.version) throw new Error('official_manifest_mismatch');
    await comparePackage(path.join(temp, 'package'), folder);
    return folder;
  } catch (error) {
    const known = /^[a-z_]+$/.test(error.message) ? error.message : 'source_verification_failed';
    throw new Error(`Argon2 package identity could not be verified (${known}). Reinstall locked dependencies with npm ci --ignore-scripts before retrying. No package code or lifecycle was executed.`);
  } finally { if (temp) await fs.rm(temp, { recursive: true, force: true }); }
}
