import { launcherDirectory, testHome } from './helpers/local-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { localCommands, parseArgs as localArgs, supervise, superviseLocal, reservePorts } from '../local/local-start.mjs';
import { parseArgs as hostArgs, render, snapshot, restore } from '../deploy/setup-systemd.mjs';
import { selectedServices, serviceUnit, serviceCatalog, mockAutostartState, configureMockAutostart, restoreMockAutostart } from '../deploy/deployment-services.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/id-start-modes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const environments = { platform: {}, runtime: {}, host: {}, web: {}, mockModel: {}, mockMcp: {} };
test('local and host enable optional services only with the explicit --mock flag', () => {
  assert.equal(localArgs([]).mock, false);
  assert.equal(localArgs(['--mock', '--no-build', '--no-install']).mock, true);
  assert.equal(hostArgs(['--host', 'example.com']).mock, undefined);
  assert.equal(hostArgs(['--mock', '--host', 'example.com']).mock, true);
  assert.deepEqual(localCommands(environments).map(command => command.port), [18300, 18304, 18301, 15173]);
  assert.deepEqual(localCommands(environments, { mock: true }).map(command => command.port), [18302, 18303, 18300, 18304, 18301, 15173]);
  assert.deepEqual(selectedServices().map(service => service.port), [18300, 18304, 18301]);
  assert.equal(selectedServices(true).length, 5);
});

test('local default, --mock, then default handover releases disabled optional ports', { timeout: 15000 }, async t => {
  const root = await fixture(t), listeners = Array.from({ length: 6 }, () => net.createServer());
  for (const server of listeners) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ports = listeners.map(server => server.address().port);
  await Promise.all(listeners.map(server => new Promise(resolve => server.close(resolve))));
  const mapping = new Map([18300, 18304, 18301, 15173, 18302, 18303].map((port, index) => [port, ports[index]]));
  const code = "const s=require('node:net').createServer();s.listen(Number(process.argv[1]),'127.0.0.1');process.on('SIGTERM',()=>s.close());";
  const runs = [];
  t.after(async () => { for (const run of runs) { await run.stop(); await run.completion; } });
  for (const [index, mock] of [false, true, false].entries()) {
    const foreign = index === 0 ? await reservePorts(ports.slice(4)) : [];
    const commands = localCommands(environments, { mock }).map(command => ({ name: command.name, file: process.execPath, args: ['-e', code, String(mapping.get(command.port))], env: { HOME: testHome }, port: mapping.get(command.port) }));
    const run = await superviseLocal({ cwd: root, commands, signalSource: new EventEmitter(), log() {}, killAfterMs: 300 });
    runs.push(run); assert.equal(run.started, true);
    assert.ok(foreign.every(server => server.listening), 'disabled optional ports are not inspected or closed');
    await Promise.all(foreign.map(server => new Promise(resolve => server.close(resolve))));
    const state = JSON.parse(await fs.readFile(path.join(launcherDirectory(root), 'instance.json'), 'utf8'));
    assert.equal(state.groups.length, mock ? 6 : 4);
    if (!mock) { const held = await reservePorts(ports.slice(4)); await Promise.all(held.map(server => new Promise(resolve => server.close(resolve)))); }
  }
  assert.equal(await runs[0].completion, 0); assert.equal(await runs[1].completion, 0);
});

test('the startup gate preserves the registered PID and starts no command before registration', { timeout: 10000 }, async t => {
  const root = await fixture(t), listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  let registeredPid, running;
  const marker = path.join(root, 'command started');
  const command = { name: 'gated-node', file: process.execPath, port, env: { HOME: testHome }, args: ['-e', "const fs=require('node:fs'),net=require('node:net');fs.writeFileSync(process.argv[1],String(process.pid));const s=net.createServer();s.listen(Number(process.argv[2]),'127.0.0.1');process.on('SIGTERM',()=>s.close());", marker, String(port)] };
  t.after(async () => { if (running) { await running.stop(); await running.completion; } });
  running = await supervise({ cwd: root, commands: [command], signalSource: new EventEmitter(), log() {}, killAfterMs: 300, registerGroup: async pid => {
    registeredPid = pid;
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  } });
  assert.equal(running.started, true);
  assert.equal(Number(await fs.readFile(marker, 'utf8')), registeredPid);
  await running.stop(); assert.equal(await running.completion, 0);
  const reservations = await reservePorts([port]); await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
});

test('real offline systemd enable/disable and rollback preserve optional service files', async t => {
  try { execFileSync('systemctl', ['--version'], { stdio: 'ignore' }); }
  catch { t.skip('systemctl unavailable; offline enablement verification requires Linux'); return; }
  const root = await fixture(t), directory = path.join(root, 'etc/systemd/system');
  await fs.mkdir(directory, { recursive: true });
  assert.ok(Object.values(mockAutostartState({ root })).every(state => state === 'not-found'));
  const source = await fs.readFile(new URL('../deploy/templates/identity.service.template', import.meta.url), 'utf8');
  const targetSource = await fs.readFile(new URL('../deploy/templates/identity.target', import.meta.url), 'utf8');
  const target = path.join(directory, 'identity.target');
  const writeTarget = mock => fs.writeFile(target, render(targetSource, { SERVICES: selectedServices(mock).map(service => serviceUnit(service.name)).join(' ') }));
  for (const service of serviceCatalog) await fs.writeFile(path.join(directory, serviceUnit(service.name)), render(source, { DESCRIPTION: service.name, ROOT: root, NODE: process.execPath, ENTRY: service.entry, ENV_FILE: service.name + '.env', SECRETS_DIRECTIVE: '' }));
  await writeTarget(false);
  const states = mockAutostartState({ root });
  assert.ok(Object.values(states).every(state => state === 'disabled'));
  configureMockAutostart(true, { root }); await writeTarget(true);
  assert.ok(Object.values(mockAutostartState({ root })).every(state => state === 'enabled'));
  const before = mockAutostartState({ root }), backup = path.join(root, 'backup'); await fs.mkdir(backup);
  const mockFiles = serviceCatalog.filter(service => service.mock).map(service => path.join(directory, serviceUnit(service.name)));
  const original = await Promise.all(mockFiles.map(file => fs.readFile(file, 'utf8')));
  const saved = await snapshot([target], backup);
  configureMockAutostart(false, { root }); await writeTarget(false);
  assert.ok(Object.values(mockAutostartState({ root })).every(state => state === 'disabled'));
  assert.doesNotMatch(await fs.readFile(target, 'utf8'), /identity-rule-model|identity-mock-mcp/);
  assert.deepEqual(await Promise.all(mockFiles.map(file => fs.readFile(file, 'utf8'))), original);
  // Exercise the same helpers used when deployment fails after changing mode.
  await restore(saved); restoreMockAutostart(before, { root });
  assert.ok(Object.values(mockAutostartState({ root })).every(state => state === 'enabled'));
  assert.match(await fs.readFile(target, 'utf8'), /identity-rule-model/);
  configureMockAutostart(false, { root }); await writeTarget(false);
  const disabledBefore = mockAutostartState({ root });
  const disabledBackup = path.join(root, 'disabled-backup'); await fs.mkdir(disabledBackup);
  const disabledSaved = await snapshot([target], disabledBackup);
  configureMockAutostart(true, { root }); await writeTarget(true);
  assert.ok(Object.values(mockAutostartState({ root })).every(state => state === 'enabled'));
  configureMockAutostart(false, { root }); await restore(disabledSaved); restoreMockAutostart(disabledBefore, { root });
  assert.ok(Object.values(mockAutostartState({ root })).every(state => state === 'disabled'));
  assert.doesNotMatch(await fs.readFile(target, 'utf8'), /identity-rule-model|identity-mock-mcp/);
});
