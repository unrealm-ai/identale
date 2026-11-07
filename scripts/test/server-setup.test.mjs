import test from 'node:test';
import { selectedServices, serviceUnit } from '../deploy/deployment-services.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { validateHost, validatePort, safePath, parseArgs, envValue, mergeEnvironment, render, renderNginx, snapshot, restore, prepareCertificate } from '../deploy/setup-systemd.mjs';

test('deployment hosts accept IPv4/DNS and reject malformed or injectable values', () => {
  assert.equal(validateHost('192.0.2.10'), '192.0.2.10');
  assert.equal(validateHost('Identity.Example.com'), 'identity.example.com');
  for (const host of ['', '999.2.3.4', '01.2.3.4', 'https://example.com', 'example.com:443', 'example.com/path', '::1', '-example.com', 'example..com', 'example.com;', 'example.com\ninclude /tmp/a;', 'a'.repeat(64) + '.com']) assert.throws(() => validateHost(host));
});

test('HTTPS ports reject reserved backend ports, HTTP conflicts and invalid numbers', () => {
  assert.equal(validatePort('15173'), 15173);
  assert.equal(validatePort(443), 443);
  for (const port of ['0', '01', '-1', '80', '18300', '18301', '18302', '18303', '18304', '65536', '443x', '443;']) assert.throws(() => validatePort(port));
});

test('paths allow spaces but reject systemd expansion and quoting hazards', () => {
  assert.equal(safePath('/srv/My Identity/data'), '/srv/My Identity/data');
  for (const value of ['relative/path', '/srv/a\nb', '/srv/$HOME', '/srv/%n', '/srv/"a', '/srv/\\a']) assert.throws(() => safePath(value));
});

test('argument parsing validates option pairs, duplicates and unknown flags', () => {
  assert.deepEqual(parseArgs(['--host', '192.0.2.10', '--port', '443', '--skip-install', '--skip-build']), { host: '192.0.2.10', port: 443, skipInstall: true, skipBuild: true });
  for (const args of [['--host'], ['--host', '--skip-build'], ['--host', 'one', '--host', 'two'], ['--cert', '/a'], ['--key', '/a'], ['--unknown']]) assert.throws(() => parseArgs(args));
});

test('environment updates preserve custom settings and never execute shell text', () => {
  const existing = '# operator note\nDENTITY_APP_ORIGIN=https://old.example\nDENTITY_MODEL_MASTER_KEY=synthetic-test-value\nCUSTOM=$(touch /tmp/identity-setup-must-not-execute)\n';
  const merged = mergeEnvironment(existing, { DENTITY_APP_ORIGIN: 'https://new.example', DENTITY_SECURE_COOKIES: 'true' });
  assert.equal(envValue(merged, 'DENTITY_APP_ORIGIN'), 'https://new.example');
  assert.ok(merged.includes('# operator note\n'));
  assert.ok(merged.includes('DENTITY_MODEL_MASTER_KEY=synthetic-test-value\n'));
  assert.ok(merged.includes('CUSTOM=$(touch /tmp/identity-setup-must-not-execute)\n'));
  assert.equal(envValue(merged, 'DENTITY_SECURE_COOKIES'), 'true');
  assert.equal(mergeEnvironment(merged, { DENTITY_APP_ORIGIN: 'https://new.example', DENTITY_SECURE_COOKIES: 'true' }), merged);
});

test('environment path quoting round trips and ambiguous managed settings fail clearly', () => {
  const merged = mergeEnvironment('', { DENTITY_DATABASE_PATH: '/srv/My Identity/control-plane.sqlite' });
  assert.equal(envValue(merged, 'DENTITY_DATABASE_PATH'), '/srv/My Identity/control-plane.sqlite');
  assert.equal(envValue("X='/srv/with spaces'\n", 'X'), '/srv/with spaces');
  assert.throws(() => envValue('X=one\nX=two\n', 'X'));
  assert.throws(() => envValue('X="unterminated\n', 'X'));
  assert.equal(envValue('OTHER=value\n', 'X'), undefined);
});

test('templates reject unresolved placeholders', () => {
  assert.equal(render('{{ONE}}/{{TWO}}', { ONE: 'one', TWO: 'two' }), 'one/two');
  assert.throws(() => render('{{MISSING}}', {}));
});

test('Nginx redirects use one canonical origin and avoid duplicate 443 listeners', async () => {
  const source = await fs.readFile(new URL('../deploy/templates/nginx.conf.template', import.meta.url), 'utf8');
  const standard = renderNginx(source, 'identity.example.com', 443);
  assert.equal((standard.match(/listen 443 ssl;/g) || []).length, 1);
  assert.ok(standard.includes('return 308 https://identity.example.com$request_uri;'));
  assert.ok(!standard.includes('default_server'));
  const custom = renderNginx(source, '192.0.2.10', 15173);
  assert.ok(custom.includes('listen 15173 ssl;'));
  assert.ok(custom.includes('return 308 https://192.0.2.10:15173$request_uri;'));
  assert.ok(custom.includes('location /internal/ { return 404; }'));
  assert.ok(custom.includes('proxy_set_header Host $http_host;'));
});

test('rendered Nginx configurations pass the real parser with an isolated certificate', async t => {
  try { execFileSync('nginx', ['-v'], { stdio: 'ignore' }); execFileSync('openssl', ['version'], { stdio: 'ignore' }); }
  catch { t.skip('nginx and openssl are required for the real parser check'); return; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-setup-nginx-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', `${temporary}/server.key`, '-out', `${temporary}/server.crt`, '-subj', '/CN=192.0.2.10', '-addext', 'subjectAltName=IP:192.0.2.10'], { stdio: 'ignore' });
    const source = await fs.readFile(new URL('../deploy/templates/nginx.conf.template', import.meta.url), 'utf8');
    for (const port of [443, 15173]) {
      const site = renderNginx(source, '192.0.2.10', port).replaceAll('/etc/identity/tls/', `${temporary}/`);
      await fs.writeFile(`${temporary}/nginx.conf`, `pid ${temporary}/nginx.pid;\nerror_log stderr;\nevents {}\nhttp { ${site} }\n`);
      execFileSync('nginx', ['-t', '-c', `${temporary}/nginx.conf`], { stdio: 'pipe' });
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('rendered service units pass real systemd validation, including checkout paths with spaces', async t => {
  try { execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' }); }
  catch { t.skip('systemd-analyze is required for the real unit parser check'); return; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'identity setup units '));
  try {
    const source = await fs.readFile(new URL('../deploy/templates/identity.service.template', import.meta.url), 'utf8');
    const files = [];
    for (const name of ['control-plane', 'runtime', 'runtime-host', 'rule-model', 'mock-mcp']) {
      const file = path.join(temporary, `identity-${name}.service`);
      const unit = render(source, { DESCRIPTION: `Identity ${name}`, ROOT: temporary, NODE: process.execPath, ENTRY: 'entry.js', ENV_FILE: `${name}.env`, SECRETS_DIRECTIVE: '' });
      await fs.writeFile(file, unit);
      files.push(file);
    }
    const target = path.join(temporary, 'identity.target');
    const targetTemplate = await fs.readFile(new URL('../deploy/templates/identity.target', import.meta.url), 'utf8');
    for (const mock of [false, true]) {
      await fs.writeFile(target, render(targetTemplate, { SERVICES: selectedServices(mock).map(service => serviceUnit(service.name)).join(' ') }));
      execFileSync('systemd-analyze', ['verify', ...files, target], { stdio: 'pipe' });
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('configuration snapshots restore files, permissions, symlinks and absent paths', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-setup-restore-'));
  try {
    const backup = path.join(temporary, 'backup');
    const config = path.join(temporary, 'platform.env');
    const absent = path.join(temporary, 'previously-absent');
    const release = path.join(temporary, 'old-release');
    const web = path.join(temporary, 'web');
    const unrelated = path.join(temporary, 'business-data');
    await fs.mkdir(backup, { mode: 0o700 });
    await fs.mkdir(release);
    await fs.writeFile(config, 'SYNTHETIC_SECRET=preserve-this-test-value\n', { mode: 0o600 });
    await fs.writeFile(unrelated, 'must remain untouched');
    await fs.symlink(release, web);
    const entries = await snapshot([config, absent, web], backup);
    await fs.writeFile(config, 'replacement');
    await fs.chmod(config, 0o644);
    await fs.mkdir(absent);
    await fs.rm(web);
    await fs.mkdir(web);
    await restore(entries);
    assert.equal(await fs.readFile(config, 'utf8'), 'SYNTHETIC_SECRET=preserve-this-test-value\n');
    assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
    await assert.rejects(fs.access(absent), { code: 'ENOENT' });
    assert.equal(await fs.readlink(web), release);
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'must remain untouched');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('supplied certificates require the configured IP and matching private key', async t => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); }
  catch { t.skip('openssl is required for the certificate integration check'); return; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-setup-tls-'));
  try {
    const cert = path.join(temporary, 'input.crt');
    const key = path.join(temporary, 'input.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', key, '-out', cert, '-subj', '/CN=192.0.2.10', '-addext', 'subjectAltName=IP:192.0.2.10'], { stdio: 'ignore' });
    const stage = path.join(temporary, 'stage');
    await fs.mkdir(stage);
    const before = await fs.readFile(cert);
    assert.deepEqual(await prepareCertificate({ cert, key }, '192.0.2.10', stage), before);
    assert.equal((await fs.stat(path.join(stage, 'server.key'))).mode & 0o777, 0o600);
    await assert.rejects(prepareCertificate({ cert, key }, '192.0.2.11', stage), /Certificate host/);
    const other = path.join(temporary, 'other.key');
    execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', other], { stdio: 'ignore' });
    await assert.rejects(prepareCertificate({ cert, key: other }, '192.0.2.10', stage), /do not match/);
    assert.deepEqual(await fs.readFile(cert), before);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('fresh self-signed certificates support long DNS names and are reused without rotating keys', async t => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); }
  catch { t.skip('openssl is required for the certificate integration check'); return; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-setup-new-tls-'));
  try {
    const host = `${'a'.repeat(63)}.example.com`;
    const certificate = await prepareCertificate({}, host, temporary, path.join(temporary, 'missing'));
    const key = await fs.readFile(path.join(temporary, 'server.key'));
    const second = path.join(temporary, 'second');
    await fs.mkdir(second);
    assert.deepEqual(await prepareCertificate({}, host, second, temporary), certificate);
    assert.deepEqual(await fs.readFile(path.join(second, 'server.key')), key);
    await fs.rm(path.join(temporary, 'server.key'));
    await assert.rejects(prepareCertificate({}, host, second, temporary), /incomplete/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('supplied expired certificates are rejected without overwriting the input pair', async t => {
  try {execFileSync('openssl', ['version'], {stdio:'ignore'});} catch {t.skip('openssl is required');return;}
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'identity-expired-cert-'));
  t.after(() => fs.rm(temporary, {recursive:true, force:true}));
  const certificate = path.join(temporary,'certificate.pem'), key = path.join(temporary,'key.pem'), expired = path.join(temporary,'expired.pem'), stage = path.join(temporary,'stage');
  await fs.mkdir(stage);
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',key,'-out',certificate,'-subj','/CN=192.0.2.10','-addext','subjectAltName=IP:192.0.2.10'],{stdio:'ignore'});
  // Negative -days is rejected by newer OpenSSL releases. Use explicit past
  // validity dates through the real CA command instead of mocking validity.
  const csr=path.join(temporary,'request.csr'),config=path.join(temporary,'ca.conf');
  await fs.writeFile(path.join(temporary,'index'),'');await fs.writeFile(path.join(temporary,'serial'),'01\n');
  await fs.writeFile(config,`[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=${temporary}/index\nserial=${temporary}/serial\nnew_certs_dir=${temporary}\ncertificate=${certificate}\nprivate_key=${key}\ndefault_md=sha256\npolicy=subject\nx509_extensions=extensions\n[subject]\ncommonName=supplied\n[extensions]\nsubjectAltName=IP:192.0.2.10\n`);
  execFileSync('openssl',['x509','-x509toreq','-in',certificate,'-signkey',key,'-out',csr],{stdio:'ignore'});
  execFileSync('openssl',['ca','-selfsign','-batch','-notext','-config',config,'-in',csr,'-startdate','20200101000000Z','-enddate','20200102000000Z','-out',expired],{stdio:'ignore'});
  const before = await fs.readFile(expired), privateBefore = await fs.readFile(key);
  const parsed=new X509Certificate(before);assert.equal(parsed.checkIP('192.0.2.10'),'192.0.2.10');assert.ok(Date.parse(parsed.validTo)<Date.now());
  await assert.rejects(prepareCertificate({cert:expired,key},'192.0.2.10',stage),/Certificate host or validity/);
  assert.deepEqual(await fs.readFile(expired),before);assert.deepEqual(await fs.readFile(key),privateBefore);
});
