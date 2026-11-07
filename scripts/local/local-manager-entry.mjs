import { startLocal } from './local-start.mjs';
import { enableLauncherParentObservation } from './local-process-diagnostics.mjs';

// Internal fixed entry; it never recursively starts another exit observer.
const [mode, ...args] = process.argv.slice(2);
if (!['initialize', 'existing'].includes(mode)) throw new Error('Invalid local manager entry mode.');
enableLauncherParentObservation();
startLocal(args, process.env, { initialize: mode === 'initialize' }).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
