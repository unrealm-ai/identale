import { execFileSync, spawnSync } from 'node:child_process';

export const serviceCatalog = [
  { name: 'control-plane', entry: 'apps/control-plane/dist/main.js', port: 18300, service: 'platform' },
  { name: 'runtime', entry: 'apps/control-plane/dist/runtime-main.js', port: 18304, service: 'interaction-task' },
  { name: 'runtime-host', entry: 'apps/runtime-host-pi/dist/main.js', port: 18301, service: 'runtime-host-pi' },
  { name: 'rule-model', entry: 'apps/mock-model/dist/main.js', port: 18302, service: 'dentity-rule-model', mock: true },
  { name: 'mock-mcp', entry: 'apps/mock-model/dist/mcp-main.js', port: 18303, service: 'dentity-mock-mcp', mock: true },
];
export const serviceUnit = name => `identity-${name}.service`;
export const selectedServices = (mock = false) => serviceCatalog.filter(service => !service.mock || mock);
const mockUnits = serviceCatalog.filter(service => service.mock).map(service => serviceUnit(service.name));
const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } };
const rootArgs = root => root ? ['--root', root] : [];

// The optional root is an offline filesystem, used with the real systemctl in
// isolated tests. It never connects those tests to the host's running manager.
export function mockAutostartState({ root } = {}) {
  return Object.fromEntries(mockUnits.map(unit => {
    const result = spawnSync('systemctl', [...rootArgs(root), 'is-enabled', unit], options);
    const state = result.stdout?.trim();
    if (result.error || !['enabled', 'enabled-runtime', 'disabled', 'static', 'indirect', 'masked', 'masked-runtime', 'not-found'].includes(state)) throw new Error('Unable to inspect optional service enablement safely.');
    return [unit, state];
  }));
}
export function configureMockAutostart(mock, { root } = {}) {
  execFileSync('systemctl', [...rootArgs(root), '--no-reload', mock ? 'enable' : 'disable', ...mockUnits], options);
}
export function restoreMockAutostart(states, { root } = {}) {
  for (const [unit, state] of Object.entries(states)) {
    if (!mockUnits.includes(unit)) throw new Error('Unknown optional service.');
    if (['enabled', 'enabled-runtime'].includes(state)) execFileSync('systemctl', [...rootArgs(root), '--no-reload', ...(state === 'enabled-runtime' ? ['--runtime'] : []), 'enable', unit], options);
  }
}
