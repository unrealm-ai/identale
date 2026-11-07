import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { baseEnvironment } from '../local/local-start.mjs';
import { repositoryRoot } from './local-secrets.mjs';
import { verifyOfficialArgon2 } from './local-native-package.mjs';

const probe = `const argon2 = require('argon2'); (async () => {
  const input = 'local-native-preflight';
  const hash = await argon2.hash(input, { memoryCost: 8192, timeCost: 1, parallelism: 1 });
  if (!await argon2.verify(hash, input)) process.exitCode = 1;
})().catch(() => { process.exitCode = 1; });`;
function run(file, args, cwd, env, timeout, inherit = false) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, shell: false, stdio: inherit ? 'inherit' : 'ignore' });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    const force = setTimeout(() => child.kill('SIGKILL'), timeout + 2000);
    child.once('error', () => { clearTimeout(timer); clearTimeout(force); resolve(false); });
    child.once('exit', code => { clearTimeout(timer); clearTimeout(force); resolve(code === 0); });
  });
}
async function probeArgon2({ cwd = repositoryRoot, env = process.env } = {}) {
  return run(process.execPath, ['-e', probe], cwd, baseEnvironment(env), 15000);
}
export async function checkArgon2({ cwd = repositoryRoot, env = process.env } = {}) {
  try { await verifyOfficialArgon2({ cwd, env }); } catch { return false; }
  return probeArgon2({ cwd, env });
}
export async function nativePreflight({ cwd = repositoryRoot, env = process.env, repair = true, log = console.log } = {}) {
  const clean = baseEnvironment(env);
  const packageDirectory = await verifyOfficialArgon2({ cwd, env: clean, allowDownload: repair });
  if (await probeArgon2({ cwd, env: clean })) { log('Argon2 native hash/verify: ready.'); return; }
  const quotedDirectory = "'" + packageDirectory.replaceAll("'", "'\\''") + "'";
  if (process.platform !== 'darwin' || !repair) throw new Error(`Argon2 native hash/verify failed. Run npm rebuild --rebuild-bundle=false ${quotedDirectory} in this repository, then restart. No service was started.`);
  log('Argon2 native preflight failed; rebuilding the locked argon2 package once…');
  // npm's name selector traverses every same-name package in its inventory.
  // A directory selector is an exact node.path match; disable bundle expansion
  // so only the package whose content was just verified can run a lifecycle.
  if (!await run('npm', ['rebuild', '--rebuild-bundle=false', packageDirectory], cwd, clean, 120000, true)) throw new Error('Argon2 rebuild failed; no service was started. Check the local Node/Xcode build tools.');
  await verifyOfficialArgon2({ cwd, env: clean, allowDownload: repair });
  if (!await probeArgon2({ cwd, env: clean })) throw new Error('Argon2 still fails after one rebuild; no service was started. Check the local Node/Xcode build tools.');
  log('Argon2 native hash/verify: repaired and ready.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  nativePreflight({ repair: !process.argv.includes('--no-repair') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
