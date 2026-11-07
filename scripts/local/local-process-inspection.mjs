import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
const exec = promisify(execFile);
const env = { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C' };
/** Read-only postcondition: an issued kill is not proof of completed exit. */
export async function processGroupEmpty(group) {
  const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pgid=,stat='], { env, timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  return !stdout.trim().split('\n').some(row => { const [pgid, stat] = row.trim().split(/\s+/); return Number(pgid) === group && !stat.startsWith('Z'); });
}
/** Read only process/socket metadata; no command arguments or environments. */
export async function listenerOwnedByGroup(port, group) {
  if (process.platform === 'darwin') {
    let output;
    try { output = (await exec('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpg'], { env, timeout: 2000, maxBuffer: 1024 * 1024 })).stdout; }
    catch (error) { if (error.code === 1 && !error.stdout) return false; throw new Error('Listener ownership inspection unavailable; startup refused.'); }
    const groups = output.split('\n').filter(line => line.startsWith('g')).map(line => Number(line.slice(1)));
    return groups.length > 0 && groups.every(value => value === group);
  }
  if (process.platform === 'linux') {
    const listeners = new Set();
    try {
      for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const table = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT' && file.endsWith('tcp6')) return ''; throw error; });
        for (const row of table.trim().split('\n').slice(1)) {
          const parts = row.trim().split(/\s+/);
          if (parts[3] === '0A' && parseInt(parts[1].split(':')[1], 16) === port) listeners.add(parts[9]);
        }
      }
      if (!listeners.size) return false;
      const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=,pgid='], { env, timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
      for (const row of stdout.trim().split('\n')) {
        const [pid, pgid] = row.trim().split(/\s+/).map(Number);
        if (pgid !== group) continue;
        const folder = `/proc/${pid}/fd`;
        const fds = await fs.readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const fd of fds) {
          const link = await fs.readlink(`${folder}/${fd}`).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
          const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
          if (inode) listeners.delete(inode);
        }
      }
      return listeners.size === 0;
    } catch { throw new Error('Listener ownership inspection unavailable; startup refused.'); }
  }
  throw new Error('Listener ownership inspection is unsupported on this OS.');
}
