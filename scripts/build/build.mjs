// Modified for Identale; see the root NOTICE.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startupStage } from '../shared/startup-progress.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const web = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const phases = {
  backend: [
    ['Backend TypeScript compilation', 'typescript/bin/tsc', ['-b'], root],
  ],
  web: [
    ['Frontend type checking', 'vue-tsc/bin/vue-tsc.js', ['--noEmit'], web],
    ['Frontend Vite bundling', 'vite/bin/vite.js', ['build'], web],
  ],
};

const [mode, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(phases, mode) || (mode !== 'web' && extra.length)) {
  console.error('Usage: node scripts/build/build.mjs backend | web [Vite options]');
  process.exitCode = 2;
} else {
  for (const [label, entry, args, cwd] of phases[mode]) {
    // npm appended options to the final `vite build` command in the original
    // workspace script. Keep type checking unchanged and let Vite parse them.
    const forwarded = entry === 'vite/bin/vite.js' ? extra : [];
    const finish = startupStage(label);
    // Keep the caller's process group and streams, including compiler errors.
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(new URL(`../../node_modules/${entry}`, import.meta.url)), ...args, ...forwarded], { cwd, stdio: 'inherit' });
      child.once('error', error => { console.error(`Unable to start ${label} (${error.code}).`); resolve({ code: 1 }); });
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) {
      finish(result.signal ? `interrupted (${result.signal})` : `failed (exit code ${result.code})`);
      if (result.signal) process.kill(process.pid, result.signal);
      else process.exitCode = result.code;
      break;
    }
    finish();
  }
}
