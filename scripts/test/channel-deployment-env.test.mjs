import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironments } from '../local/local-start.mjs';

test('long-connection launcher does not forward obsolete HTTP callback trust settings', async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'dentity-ding-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const variable = 'DENTITY_DINGTALK_TRUSTED_HTTPS_BOUNDARY';
  for (const value of [undefined, 'true', 'false', '', 'invalid']) {
    const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), ...(value === undefined ? {} : { [variable]: value }) };
    const children = await childEnvironments(env);
    assert.equal(Object.hasOwn(children.platform, variable), false);
    for (const target of ['host', 'web', 'build']) assert.equal(Object.hasOwn(children[target], variable), false);
  }
});
