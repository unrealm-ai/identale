// Modified for Identale; see the root NOTICE.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const overridesRoot = fileURLToPath(new URL('./license-overrides/', import.meta.url));
const legalName = /^(?:(?:third[-_. ]party[-_. ])?(?:licen[cs]es?|notices?|copyright)|copying)(?:[._ -]|$)/i;
const licenseName = /^(?:licen[cs]es?|copying)(?:[._ -]|$)/i;
const slash = value => value.split(path.sep).join('/');
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function legalFiles(root, publicAssets = false, relative = '') {
  const files = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await legalFiles(root, publicAssets, name));
    else if (entry.isFile() && (legalName.test(entry.name) || relative.split(path.sep).some(part => legalName.test(part)) || publicAssets && /^(SOURCES|CN-V2)\.md$/.test(entry.name))) files.push(slash(name));
  }
  return files.sort();
}

function packageDirectory(id) {
  const clean = id.replace(/^\0/, '').split('?')[0];
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = clean.lastIndexOf(marker);
  if (index < 0) return null;
  const rest = clean.slice(index + marker.length).split(path.sep);
  return clean.slice(0, index + marker.length) + rest.slice(0, rest[0].startsWith('@') ? 2 : 1).join(path.sep);
}

function runtimeHelperPackage(id) {
  if (id.startsWith('\0vite/') || id === '\0commonjsHelpers.js') return 'vite';
  if (id.startsWith('\0plugin-vue:')) return '@vitejs/plugin-vue';
  return null;
}

export function webLicenses({ repositoryRoot }) {
  const root = path.resolve(repositoryRoot);
  const require = createRequire(path.join(root, 'apps/web/package.json'));
  return {
    name: 'identale-distribution-licenses',
    apply: 'build',
    enforce: 'post',
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const lockBytes = await fs.readFile(path.join(root, 'package-lock.json'));
      const lock = JSON.parse(lockBytes);
      const overrides = JSON.parse(await fs.readFile(path.join(overridesRoot, 'manifest.json'), 'utf8'));
      const packages = new Map();
      const addModule = (id, helper = null) => {
        const directory = helper ? path.dirname(require.resolve(`${helper}/package.json`)) : packageDirectory(id);
        if (!directory && id.startsWith('\0')) this.error('Unrecognized bundled virtual module; review its license attribution before publishing.');
        if (!directory) return;
        const modules = packages.get(directory) ?? new Set();
        modules.add(helper ? `runtime helper: ${id.replace(/^\0/, '')}` : slash(path.relative(directory, id.split('?')[0])));
        packages.set(directory, modules);
      };
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          for (const [id, rendered] of Object.entries(output.modules)) {
            if (rendered.renderedLength > 0) addModule(id, runtimeHelperPackage(id));
          }
        } else {
          // Vite exposes the source paths of emitted CSS and imported assets here.
          for (const id of output.originalFileNames ?? []) addModule(id);
        }
      }
      if (!packages.size) this.error('No bundled dependencies were found; review the license collector before publishing.');
      const dependencies = [];
      const sections = [
        'Identale web distribution: third-party licenses and notices',
        'Project license: LICENSE. Project attribution: NOTICE.',
        'This file is generated from rendered Rollup chunks and emitted asset sources, not the entire npm dependency tree.',
        'Build-tool entries occur only when their runtime helpers ship. Their complete upstream license files may also describe code not shipped here.',
        'Original license / notice files are kept unchanged. Explicitly labeled supplements address packages that omit them; metadata is not a replacement for license text.',
        '',
      ];
      for (const [directory, modules] of [...packages].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
        const location = slash(path.relative(root, directory));
        const locked = lock.packages[location];
        if (!locked || locked.version !== metadata.version || !metadata.name || typeof metadata.license !== 'string') {
          this.error(`Bundled dependency metadata does not match the lockfile: ${location}. Run npm ci and review its license.`);
        }
        const names = await legalFiles(directory);
        const documents = [];
        for (const file of names) {
          const content = await fs.readFile(path.join(directory, file), 'utf8');
          if (!content.trim()) this.error(`Empty license / notice: ${metadata.name}/${file}`);
          documents.push({ file, source: `${location}/${file}`, sha256: sha256(content), content });
        }
        let warning;
        if (!names.some(file => file.split('/').some(part => licenseName.test(part)))) {
          const override = overrides[`${metadata.name}@${metadata.version}`];
          if (!override || override.integrity !== locked.integrity || override.license !== metadata.license) {
            this.error(`Missing original license text for ${metadata.name}@${metadata.version}; add a version-specific, source-verified supplement.`);
          }
          const content = await fs.readFile(path.join(overridesRoot, override.file), 'utf8');
          if (sha256(content) !== override.sha256) this.error(`License supplement hash mismatch: ${override.file}`);
          documents.push({ file: override.file, source: override.source, sha256: override.sha256, content });
          warning = override.warning;
          if (warning) this.warn(`${metadata.name}@${metadata.version}: ${warning}`);
        }
        const notices = names.filter(file => /notice/i.test(path.basename(file)));
        const noticeStatus = notices.length ? 'Standalone notices included verbatim.' : 'No standalone NOTICE file found in the installed package; no NOTICE invented.';
        const dependency = {
          name: metadata.name, version: metadata.version, license: metadata.license,
          modules: [...modules].sort(), documents: documents.map(({ content, ...document }) => document),
          notices, noticeStatus, ...(warning ? { warning } : {}),
        };
        dependencies.push(dependency);
        sections.push('='.repeat(78), `${metadata.name}@${metadata.version}`, `Declared license: ${metadata.license}`, noticeStatus);
        if (warning) sections.push(`REVIEW NOTE: ${warning}`, `Published author metadata (not a copyright assertion): ${typeof metadata.author === 'string' ? metadata.author : JSON.stringify(metadata.author)}`);
        for (const document of documents) sections.push(`\n--- ${document.file} ---\nSource: ${document.source}\nSHA-256: ${document.sha256}\n\n${document.content}`);
      }
      dependencies.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
      const publicRoot = path.join(root, 'apps/web/public');
      const publicNotices = [];
      sections.push('='.repeat(78), 'Static asset notices copied from public/ (not npm runtime packages)');
      for (const file of await legalFiles(publicRoot, true)) {
        const content = await fs.readFile(path.join(publicRoot, file), 'utf8');
        publicNotices.push({ file, sha256: sha256(content) });
        sections.push(`\n--- ${file} ---\n\n${content}`);
      }
      const emitted = new Map();
      for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
        const content = await fs.readFile(path.join(root, file));
        if (!content.toString('utf8').trim()) this.error(`Empty project license / notice: ${file}`);
        emitted.set(file, content);
      }
      emitted.set('THIRD_PARTY_NOTICES.txt', sections.join('\n') + '\n');
      for (const [fileName, source] of emitted) {
        if (bundle[fileName]) this.error(`License artifact name collision: ${fileName}`);
        this.emitFile({ type: 'asset', fileName, source });
      }
      const artifacts = Object.values(bundle).filter(output => !emitted.has(output.fileName)).map(output => ({
        file: output.fileName, sha256: sha256(output.type === 'chunk' ? output.code : output.source),
      })).sort((a, b) => a.file.localeCompare(b.file, 'en'));
      const manifest = {
        formatVersion: 1, collector: 'Rollup rendered modules and emitted asset originalFileNames, including Vite / Vue runtime helpers',
        lockfileSha256: sha256(lockBytes),
        projectFiles: ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'],
        legalFiles: [...emitted].map(([file, content]) => ({ file, sha256: sha256(content) })),
        publicNotices, artifacts, dependencies,
      };
      this.emitFile({ type: 'asset', fileName: 'third-party-licenses.json', source: JSON.stringify(manifest, null, 2) + '\n' });
    } },
  };
}
