import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvocationContext } from '@dentity/domain';
import type { ResolvedAgentSpec } from '@dentity/contracts';

export const STANDARD_TOOL_NAMES = ['read', 'write', 'edit', 'bash'] as const;
export type StandardToolName = typeof STANDARD_TOOL_NAMES[number];
export interface RegisteredExecutionResource {
  resourceId: string;
  version: string;
  /** Only private per-task roots currently have verified lifecycle and link semantics. */
  mode: 'task' | 'project';
  root: string;
  tools: StandardToolName[];
}
export interface ResolvedExecutionResource extends RegisteredExecutionResource { directory: string }
export const inside = (parent: string, child: string): boolean => { const r = relative(parent, child); return r === '' || r !== '..' && !r.startsWith('../') && !isAbsolute(r); };
export function validateExecutionResources(resources: readonly RegisteredExecutionResource[] = []): void {
  const ids = new Set<string>();
  for (const item of resources) {
    if (!item || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(item.resourceId) || ids.has(item.resourceId) || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(item.version) || !['task','project'].includes(item.mode) || !isAbsolute(item.root) || !Array.isArray(item.tools) || !item.tools.length || item.tools.some(t => !(STANDARD_TOOL_NAMES as readonly string[]).includes(t)) || new Set(item.tools).size !== item.tools.length || Object.keys(item).some(k => !['resourceId','version','mode','root','tools'].includes(k))) throw new Error('Invalid execution resource registration');
    ids.add(item.resourceId);
  }
}
/** The spec carries only approved references; deployment registry owns the real path. */
export function resolveExecutionResource(spec: ResolvedAgentSpec, resources: readonly RegisteredExecutionResource[] = []): RegisteredExecutionResource | undefined {
  validateExecutionResources(resources);
  const refs = spec.executionResources ?? [];
  if (!Array.isArray(refs) || refs.length > 1 || spec.role !== 'execution' && refs.length) throw new Error('Execution resource scope invalid');
  const ref = refs[0]; if (!ref) return undefined;
  const resource = resources.find(r => r.resourceId === ref.resourceId && r.version === ref.version);
  if (!resource || Object.keys(ref).some(k => !['resourceId','version','tools'].includes(k)) || !Array.isArray(ref.tools) || !ref.tools.length || new Set(ref.tools).size !== ref.tools.length || ref.tools.some((t: StandardToolName) => !resource.tools.includes(t))) throw new Error('Execution resource not approved');
  // A project root may have pre-existing outside hardlinks or concurrent writers. Do not
  // advertise the requested strict scope until that deployment mode can be enforced.
  if (resource.mode !== 'task') throw new Error('Project execution isolation not supported; use a private task directory');
  return { ...resource, tools: [...ref.tools] };
}
function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(path), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolve(path) || stat.mode & 0o077 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Execution directory must be canonical, owned and private');
  return canonical;
}
/** Host-owned baseline tools; optional registrations can narrow the baseline. */
export function executionResourceFor(spec: ResolvedAgentSpec, resources: readonly RegisteredExecutionResource[], privateStateRoot: string): RegisteredExecutionResource | undefined {
  const explicit = resolveExecutionResource(spec, resources);
  if (explicit || spec.role !== 'execution') return explicit;
  const state = realpathSync(privateStateRoot);
  return { resourceId: 'local-pi-default-tools', version: '1', mode: 'task', root: `${state}-execution`, tools: [...STANDARD_TOOL_NAMES] };
}
export function taskExecutionResource(resource: RegisteredExecutionResource, context: InvocationContext, privateStateRoot: string): ResolvedExecutionResource {
  if (context.target.kind !== 'task_run') throw new Error('Local tools require a task run');
  const root = privateDirectory(resource.root), state = realpathSync(privateStateRoot);
  if (inside(root, state) || inside(state, root)) throw new Error('Execution root overlaps private runtime state');
  const dependencyRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '../../..'));
  if(inside(dependencyRoot,state))throw new Error('Private runtime state overlaps readable tool dependencies');
  const key = createHash('sha256').update(JSON.stringify([context.workspaceId, context.entityId, context.trigger, context.sessionId, context.target])).digest('hex');
  const directory = privateDirectory(join(root, key));
  if (!inside(root, directory)) throw new Error('Execution root changed');
  return { ...resource, root, directory };
}
