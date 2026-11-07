import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEntityAccess, evaluatePackageAccess, projectRoleResources } from '../dist/authorization.js';

const channel = { channelType: 'test', tenantId: 'tenant', installationId: 'install' };
const principal = id => ({ channelType: channel.channelType, tenantId: channel.tenantId, identityNamespace: 'users', externalUserId: id });
const known = value => ({ status: 'known', value });
const request = (id = 'A', conversationId = 'X') => ({ workspaceId: 'workspace', principal: known(principal(id)), channel, conversation: { id: conversationId, kind: 'group' }, workspaceMemberIds: known([]), verifiedGroupIds: known([]), identifiedInWorkspace: known(true) });
const rule = (id = 'A', conversationId = 'X') => ({ requester: { kind: 'principals', values: [principal(id)] }, channel: { channel, kinds: ['group'], conversationIds: [conversationId] } });
const entity = (allow = [rule()], deny = []) => ({ workspaceId: 'workspace', enabled: true, allow, deny });
const pkg = (mode = 'inherit', allow = [], deny = []) => ({ enabled: true, mode, allow, deny });

test('paired A × X and B × Y rules never grant cross products', () => {
  const policy = entity([rule('A', 'X'), rule('B', 'Y')]);
  for (const [id, conversation, allowed] of [['A', 'X', true], ['B', 'Y', true], ['A', 'Y', false], ['B', 'X', false]]) assert.equal(evaluateEntityAccess(policy, request(id, conversation)).allowed, allowed);
});
test('default deny and explicit empty selector lists deny', () => {
  assert.equal(evaluateEntityAccess(entity([]), request()).reason, 'no_allow');
  for (const emptyRule of [ { ...rule(), requester: { kind: 'principals', values: [] } }, { ...rule(), channel: { ...rule().channel, conversationIds: [] } }, { ...rule(), channel: { ...rule().channel, kinds: [] } } ]) assert.equal(evaluateEntityAccess(entity([emptyRule]), request()).allowed, false);
});
test('entity deny wins; package inheritance cannot widen entity access', () => {
  assert.equal(evaluatePackageAccess(entity([rule()], [rule()]), pkg('restrict', [rule()]), request()).reason, 'explicit_deny');
  assert.equal(evaluatePackageAccess(entity([]), pkg('restrict', [rule()]), request()).allowed, false);
  assert.equal(evaluatePackageAccess(entity(), pkg(), request()).allowed, true);
});
test('package restrict requires an allow; all package denies win', () => {
  assert.equal(evaluatePackageAccess(entity(), pkg('restrict'), request()).allowed, false);
  assert.equal(evaluatePackageAccess(entity(), pkg('restrict', [rule()]), request()).allowed, true);
  for (const mode of ['inherit', 'restrict']) assert.equal(evaluatePackageAccess(entity(), pkg(mode, [rule()], [rule()]), request()).reason, 'explicit_deny');
});
test('disabled entity or package is denied', () => {
  assert.equal(evaluatePackageAccess({ ...entity(), enabled: false }, pkg(), request()).reason, 'disabled');
  assert.equal(evaluatePackageAccess(entity(), { ...pkg(), enabled: false }, request()).reason, 'disabled');
});
test('unknown or malformed identity and wrong namespace, tenant, installation fail closed', () => {
  for (const value of [undefined, null, {}, { ...principal('A'), identityNamespace: '' }, { ...principal('A'), tenantId: '' }]) assert.equal(evaluateEntityAccess(entity(), { ...request(), principal: known(value) }).allowed, false);
  for (const status of ['unknown', 'unsupported']) assert.equal(evaluateEntityAccess(entity(), { ...request(), principal: { status } }).allowed, false);
  for (const field of ['tenantId', 'channelType']) assert.equal(evaluateEntityAccess(entity(), { ...request(), principal: known({ ...principal('A'), [field]: 'other' }) }).allowed, false);
  assert.equal(evaluateEntityAccess(entity(), { ...request(), principal: known({ ...principal('A'), identityNamespace: 'other' }) }).allowed, false);
  assert.equal(evaluateEntityAccess(entity(), { ...request(), channel: { ...channel, installationId: 'other' } }).allowed, false);
});
test('member, verified group and identified workspace facts are explicit, unknown facts deny', () => {
  for (const [selector, field, value] of [[{ kind: 'workspace_members', ids: ['member'] }, 'workspaceMemberIds', ['member']], [{ kind: 'verified_groups', ids: ['group'] }, 'verifiedGroupIds', ['group']], [{ kind: 'identified_workspace_users' }, 'identifiedInWorkspace', true]]) {
    const selected = { ...rule(), requester: selector };
    assert.equal(evaluateEntityAccess(entity([selected]), { ...request(), [field]: known(value) }).allowed, true);
    for (const status of ['unknown', 'unsupported']) {
      const req = { ...request(), [field]: { status } };
      assert.equal(evaluateEntityAccess(entity([selected]), req).reason, 'unknown_fact');
      assert.equal(evaluateEntityAccess(entity([rule()], [selected]), req).reason, 'unknown_fact');
    }
  }
  assert.equal(evaluateEntityAccess(entity([{ ...rule(), requester: { kind: 'script', code: 'true' } }]), request()).reason, 'invalid_policy');
});
test('unknown facts on an unrelated channel do not block a concrete allowed pair', () => {
  const unrelated = { ...rule('A', 'Y'), requester: { kind: 'verified_groups', ids: ['group'] } };
  assert.equal(evaluateEntityAccess(entity([rule()], [unrelated]), { ...request(), verifiedGroupIds: { status: 'unknown' } }).allowed, true);
});
test('interaction projection permits only explicitly authorized task and readonly knowledge resources', () => {
  const resources = [{ kind: 'platform_task', id: 'task_create' }, { kind: 'knowledge_read', id: 'read', packageId: 'p', collectionId: 'k' }, { kind: 'skill', id: 'skill', packageId: 'p' }, { kind: 'mcp_tool', id: 'mcp', packageId: 'p', connectionId: 'c', toolName: 'read' }, { kind: 'cli', id: 'cli', packageId: 'p' }, { kind: 'shell', id: 'shell' }];
  const result = projectRoleResources('interaction', resources, resources);
  assert.equal(result.valid, false);
  assert.deepEqual(result.resources, resources.slice(0, 2));
  assert.equal(result.rejected.length, 4);
  assert.equal(projectRoleResources('interaction', resources.slice(0, 2), []).resources.length, 0);
});
test('execution intersects concrete ids, packages, MCP connections and tool names; no wildcard', () => {
  const resource = { kind: 'mcp_tool', id: 'mcp', packageId: 'p', connectionId: 'c', toolName: 'read' };
  assert.equal(projectRoleResources('execution', [resource], [resource]).valid, true);
  for (const field of ['id', 'packageId', 'connectionId', 'toolName']) assert.equal(projectRoleResources('execution', [{ ...resource, [field]: 'other' }], [resource]).valid, false);
  assert.equal(projectRoleResources('execution', [{ ...resource, toolName: '*' }], [{ ...resource, toolName: '*' }]).valid, false);
  assert.equal(projectRoleResources('interaction', [{ kind: 'platform_task', id: 'shell' }], [{ kind: 'platform_task', id: 'shell' }]).valid, false);
});

test('unsupported policy conditions are rejected rather than silently ignored', () => {
  assert.equal(evaluateEntityAccess({ ...entity(), script: 'true' }, request()).reason, 'invalid_policy');
  for (const selected of [{ ...rule(), timeWindow: 'night' }, { ...rule(), requester: { ...rule().requester, requiredDepartment: 'hr' } }, { ...rule(), channel: { ...rule().channel, requiredThread: 'thread' } }]) assert.equal(evaluateEntityAccess(entity([selected]), request()).reason, 'invalid_policy');
  assert.equal(evaluatePackageAccess(entity(), { ...pkg(), mode: 'script' }, request()).reason, 'invalid_policy');
});
