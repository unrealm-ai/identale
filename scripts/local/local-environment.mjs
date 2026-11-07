// Modified for Identale; see the root NOTICE.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { repositoryRoot } from '../shared/local-secrets.mjs';
import { defaultSecretPath, expandLocalPath, localDatabasePaths, localResourcePaths } from '../shared/local-paths.mjs';

const pathKeys = ['DENTITY_LOCAL_SECRETS_PATH', 'DENTITY_DATABASE_PATH', 'DENTITY_RUNTIME_DATABASE_PATH', 'DENTITY_BUILTIN_RECORD_ROOT', 'DENTITY_RUNTIME_HOST_STATE_DIR', 'DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY', 'DENTITY_SKILL_RESOURCE_ROOT'];
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

/** Local launcher only. Parse data; never source or execute the environment file. */
export async function loadLocalEnvironment(env = process.env, root = repositoryRoot) {
  const file = path.join(root, '.env');
  const effective = { ...env };
  if (!await exists(file)) {
    let template = await fs.readFile(path.join(root, '.env.example'), 'utf8');
    const databases = localDatabasePaths(env, root);
    const resources = localResourcePaths(env, root);
    const defaults = {
      DENTITY_LOCAL_SECRETS_PATH: env.DENTITY_LOCAL_SECRETS_PATH || defaultSecretPath(env),
      DENTITY_DATABASE_PATH: databases.platform,
      DENTITY_RUNTIME_DATABASE_PATH: databases.runtime,
      DENTITY_RUNTIME_HOST_STATE_DIR: resources.state,
      DENTITY_SKILL_RESOURCE_ROOT: resources.skills,
    };
    for (const [key, value] of Object.entries(defaults)) template = template.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${JSON.stringify(value)}`);
    // Publish the complete file atomically and never overwrite a concurrent edit.
    const temporary = await fs.mkdtemp(path.join(root, '.local-env-'));
    try {
      const staged = path.join(temporary, 'env');
      await fs.writeFile(staged, template, { mode: 0o600 });
      try { await fs.link(staged, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Local .env must be a regular file smaller than 1 MiB.');
    const values = parseEnv(await handle.readFile('utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith('DENTITY_')) throw new Error('Local .env supports DENTITY_* settings only; shell content is never executed.');
      if (!Object.hasOwn(env, key)) effective[key] = value;
    }
  } finally { await handle.close(); }
  for (const key of pathKeys) if (effective[key]) effective[key] = expandLocalPath(effective[key], effective, root);
  return effective;
}
