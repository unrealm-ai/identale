// Modified for Identale; see the root NOTICE.
import { after } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { localLauncherDirectory } from '../../shared/local-paths.mjs';

// Each test file runs in its own Node process. Keep default launcher state in a
// short, private temporary home, including when helpers spawn another manager.
export const testHome = realpathSync(mkdtempSync('/tmp/id-home-'));
const originalHome = process.env.HOME;
process.env.HOME = testHome;
after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});
export const launcherDirectory = root => localLauncherDirectory(root, { HOME: testHome });
