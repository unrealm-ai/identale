import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderNginx } from '../deploy/setup-systemd.mjs';

const source = await readFile(new URL('../deploy/templates/nginx.conf.template', import.meta.url), 'utf8');

// Static policy checks complement the optional real Nginx parser check in
// server-setup.test.mjs. They do not claim to exercise live proxy behavior.
for (const port of [443, 15173]) {
  test(`Nginx on ${port} uses only query-free access logging on every listener`, () => {
    const site = renderNginx(source, 'identity.example.com', port);
    const format = /log_format identity_safe ([^;]+);/.exec(site)?.[1];
    assert.ok(format);
    assert.deepEqual([...format.matchAll(/\$([a-zA-Z_]+)/g)].map(match => match[1]), [
      'remote_addr', 'time_local', 'request_method', 'uri', 'server_protocol', 'status', 'body_bytes_sent',
    ]);
    // In particular, $request, $request_uri, $args and $http_referer must not
    // reintroduce authorization codes or state, including on redirect servers.
    const servers = site.split(/^server \{/m).slice(1);
    assert.equal(servers.length, port === 443 ? 2 : 3);
    for (const server of servers) {
      assert.match(server, /^\s*access_log \/var\/log\/nginx\/identity-access\.log identity_safe;/m);
    }
    for (const [, directive] of site.matchAll(/^\s*access_log ([^;]+);/gm)) {
      assert.ok(['off', '/var/log/nginx/identity-access.log identity_safe'].includes(directive));
    }
  });
}

test('OAuth callback discards access and error logs without losing API proxy settings', () => {
  const api = source.slice(source.indexOf('    location /api/ {'), source.indexOf('    location /internal/'));
  const callback = /location = \/api\/business-resources\/feishu\/callback \{([^}]+)\}/.exec(api)?.[1];
  assert.ok(callback);
  assert.match(callback, /access_log off;/);
  assert.match(callback, /error_log \/dev\/null;/);
  assert.match(callback, /proxy_pass http:\/\/127\.0\.0\.1:18300;/);
  // No local proxy_set_header overrides: the parent API's complete header set
  // (including HTTPS and original host) is inherited by this exact location.
  assert.doesNotMatch(callback, /proxy_set_header/);
  for (const header of ['Host $http_host', 'X-Real-IP $remote_addr', 'X-Forwarded-For $remote_addr', 'X-Forwarded-Proto https']) {
    assert.ok(api.includes(`proxy_set_header ${header};`));
  }
  assert.ok(api.indexOf('proxy_read_timeout 300s;') < api.indexOf('location ='));
});
