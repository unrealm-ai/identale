// Modified for Identale; see the root NOTICE.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requiredLegal = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt'];

export async function validateWebDistribution(directory, repositoryRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'third-party-licenses.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || !manifest.dependencies?.length || !manifest.artifacts?.some(item => item.file === 'index.html')) {
    throw new Error('Unsupported or incomplete web license manifest. Rebuild the web distribution.');
  }
  if (!requiredLegal.every(file => manifest.legalFiles?.some(item => item.file === file))) {
    throw new Error('Web distribution is missing required license records. Rebuild before deployment.');
  }
  for (const item of [...manifest.legalFiles, ...manifest.publicNotices, ...manifest.artifacts]) {
    if (typeof item.file !== 'string' || item.file.startsWith('/') || item.file.includes('\\') || item.file.split('/').includes('..')) throw new Error('Invalid web manifest path.');
    const file = path.join(directory, item.file);
    if (!(await fs.lstat(file)).isFile() || sha256(await fs.readFile(file)) !== item.sha256) {
      throw new Error(`Web distribution content differs from its license manifest: ${item.file}. Rebuild before deployment.`);
    }
  }
  if (repositoryRoot) {
    if (sha256(await fs.readFile(path.join(repositoryRoot, 'package-lock.json'))) !== manifest.lockfileSha256) throw new Error('Web license manifest uses a different lockfile. Rebuild before deployment.');
    for (const file of requiredLegal.filter(file => file !== 'THIRD_PARTY_NOTICES.txt')) {
      const record = manifest.legalFiles.find(item => item.file === file);
      if (sha256(await fs.readFile(path.join(repositoryRoot, file))) !== record.sha256) throw new Error(`Web distribution contains stale ${file}. Rebuild before deployment.`);
    }
  }
  return manifest;
}

export async function copyWebDistribution(source, destination, repositoryRoot) {
  await validateWebDistribution(source, repositoryRoot);
  await fs.cp(source, destination, { recursive: true });
  await validateWebDistribution(destination, repositoryRoot);
}
