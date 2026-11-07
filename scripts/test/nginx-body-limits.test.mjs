import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderNginx } from '../deploy/setup-systemd.mjs';

const source = await readFile(new URL('../deploy/templates/nginx.conf.template', import.meta.url), 'utf8');
const bytes = value => {
  const [, amount, unit = ''] = /^(\d+)([km]?)$/.exec(value);
  return Number(amount) * ({ '': 1, k: 1024, m: 1024 * 1024 }[unit]);
};

// This checks the template's deliberately simple regex allowlist, not Nginx's
// parser or HTTP behavior. The real parser check lives in server-setup.test.mjs.
function limits(site) {
  const defaultLimit = bytes(/client_max_body_size\s+(\w+);/.exec(site)[1]);
  const exceptions = [...site.matchAll(/location ~ (\S+) \{\s*client_max_body_size (\w+);\s*proxy_pass (\S+);\s*\}/g)]
    .map(([, pattern, size, upstream]) => ({ pattern: new RegExp(pattern), size: bytes(size), upstream }));
  return {
    defaultLimit,
    exceptions,
    forPath: path => exceptions.find(entry => entry.pattern.test(path.split('?')[0]))?.size ?? defaultLimit,
  };
}

const workspace = '/api/workspaces/ws-one';
const entity = `${workspace}/entities/employee-one`;
const largeBodyRoutes = [
  [`${workspace}/skills/imports`, 29 * 1024 * 1024],
  [`${workspace}/skill-resources`, 400000],
  [`${workspace}/skills/uploaded-skill-one/status`, 400000],
  [`${workspace}/mcp-resources`, 400000],
  [`${workspace}/mcp-resources/discover`, 400000],
  [`${workspace}/mcp-resources/server-one/status`, 400000],
  [`${entity}/group-sharing`, 1024 * 1024],
  [`${entity}/triggers`, 128000],
  [`${entity}/triggers/trigger-one`, 128000],
  [`${entity}/triggers/trigger-one/credentials`, 128000],
  [`${entity}/triggers/trigger-one/credentials/key-one/revoke`, 128000],
  [`${entity}/trigger-history-policy`, 128000],
  [`${entity}/trigger-preview`, 128000],
  ['/api/triggers/webhook/trigger-one', 128000],
  ['/api/triggers/github/trigger-one', 128000],
];

for (const port of [443, 15173]) {
  test(`Nginx on ${port} assigns existing platform limits only to declared large-body routes`, () => {
    const site = renderNginx(source, 'identity.example.com', port);
    const config = limits(site);
    assert.equal(config.defaultLimit, 16 * 1024);
    assert.equal(config.exceptions.length, 5);
    assert.equal((site.match(/client_max_body_size/g) || []).length, 6);
    for (const [path, expected] of largeBodyRoutes) {
      assert.equal(config.forPath(path), expected, path);
      assert.equal(config.forPath(`${path}?view=full`), expected, `${path} with query`);
      assert.equal(config.exceptions.filter(entry => entry.pattern.test(path)).length, 1, `${path} has one matching exception`);
    }
    for (const entry of config.exceptions) assert.equal(entry.upstream, 'http://127.0.0.1:18300');
  });
}

test('ordinary routes and near-miss paths retain the 16 KiB default', () => {
  const config = limits(renderNginx(source, 'identity.example.com', 443));
  const paths = [
    '/', '/api/auth/login', '/api/auth/register', '/api/workspaces',
    `${workspace}/skills`, `${workspace}/skills/skill-one/versions`,
    `${workspace}/trigger-preview`, `${workspace}/model-profiles`,
    `${entity}/conversations`, `${entity}/capability-packages`,
    `${entity}/skill-resources`, // This old endpoint refuses employee resource creation.
    `${entity}/group-sharing/candidates`, `${entity}/group-sharing/status`,
    `${entity}/triggers/trigger-one/events`,
    '/api/triggers/other/trigger-one', '/api/triggers/github',
    ...largeBodyRoutes.flatMap(([path]) => [path + '/', path + '/unrelated/extra', '/prefix' + path, path.replace('/api/', '/api-v2/')]),
  ];
  for (const path of paths) assert.equal(config.forPath(path), 16 * 1024, path);
});

test('large-body locations share the existing API headers and preserve private-path guards', () => {
  const api = source.slice(source.indexOf('    location /api/ {'), source.indexOf('    location /internal/'));
  const guard = api.indexOf('location ~ /\\. { return 404; }');
  assert.ok(guard >= 0 && guard < api.indexOf('client_max_body_size'));
  assert.match(source, /location \/internal\/ \{ return 404; \}/);
  for (const directive of [
    'proxy_http_version 1.1;',
    'proxy_set_header Host $http_host;',
    'proxy_set_header X-Real-IP $remote_addr;',
    'proxy_set_header X-Forwarded-For $remote_addr;',
    'proxy_set_header X-Forwarded-Proto https;',
    'proxy_read_timeout 300s;',
  ]) {
    assert.equal(api.split(directive).length - 1, 1, directive);
    assert.ok(api.indexOf(directive) < api.indexOf('location ~'), `${directive} is inherited from /api/`);
  }
});

test('Skill import allowance includes base64 overhead and stays aligned with platform source limits', async () => {
  const readSource = file => readFile(new URL(`../../apps/control-plane/src/${file}`, import.meta.url), 'utf8');
  const [resources, capabilities, sharing, triggers, platform, skillPackage] = await Promise.all([
    readSource('workspace-resources.ts'), readSource('capability-config.ts'), readSource('group-sharing/configuration.ts'),
    readSource('triggers/routes.ts'), readSource('split/server.ts'), readSource('skill-package.ts'),
  ]);
  assert.match(resources, /bodyLimit\s*=\s*400000/);
  assert.match(resources, /route\('POST','\/skills\/imports',[^\n]+,29\s*\*\s*1024\s*\*\s*1024\)/);
  assert.match(capabilities, /app\.post\(root\+'\/skill-resources',\{bodyLimit:\s*400000\}/);
  assert.match(sharing, /app\.put\(base,\{bodyLimit:\s*1048576\}/);
  assert.match(triggers, /bodyLimit:\s*128000/);
  assert.match(platform, /ingress\.post\('\/api\/triggers\/:kind\/:triggerId',\{bodyLimit:\s*128000/);
  assert.match(skillPackage, /packed:\s*20\s*\*\s*1024\s*\*\s*1024/);
  const encodedZipBytes = 4 * Math.ceil(20 * 1024 * 1024 / 3);
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ kind: 'zip', data: '', operationId: 'x'.repeat(160) }));
  const importLimit = limits(source).forPath(`${workspace}/skills/imports`);
  assert.ok(encodedZipBytes + envelopeBytes < importLimit);
  assert.equal(importLimit, 29 * 1024 * 1024);
});
