import { createInterface } from 'node:readline/promises';
import { initializeSecrets, secretPath } from '../shared/local-secrets.mjs';
import { loadLocalEnvironment } from './local-environment.mjs';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--yes') || args.length > 1) throw new Error('Usage: npm run local:init -- [--yes]');
  console.log('This creates persistent local credentials only if missing. A new key cannot decrypt credentials encrypted with a lost or different key. Restore your original key backup first if recovering an existing database.');
  let confirmed = args.includes('--yes');
  if (!confirmed && !process.stdin.isTTY) throw new Error('Run interactively or explicitly pass --yes to authorize persistent local secret creation.');
  const env = await loadLocalEnvironment();
  if (!confirmed) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { confirmed = (await prompt.question(`Create or reuse private local credentials at ${secretPath(env)}? Type yes: `)).trim() === 'yes'; }
    finally { prompt.close(); }
  }
  const result = await initializeSecrets({ confirmed, env });
  console.log(`${result.created ? 'Created' : 'Reused'} private local credentials: ${result.path}`);
  console.log('Back up this file privately with your database. Losing the master key makes stored model credentials unreadable.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
