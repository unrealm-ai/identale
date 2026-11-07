import { createHash } from 'node:crypto';
import type { ResolvedAgentSpec } from '@dentity/contracts';
import { validateExecutionResources, type RegisteredExecutionResource } from './execution-resources.js';
export interface RegisteredMcpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface RegisteredMcpServer { serverRef: string; endpoint: string; tools: RegisteredMcpTool[]; headers?:Record<string,string>;version?:string }
/** Deployment-owned allowlist. No registry editing or package installation HTTP endpoint exists. */
export interface ResourceRegistry { mcpServers: RegisteredMcpServer[]; skills?: RegisteredSkill[]; executionResources?: RegisteredExecutionResource[] }
export const EMPTY_REGISTRY: ResourceRegistry = { mcpServers: [] };
export function digest(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,sorted(x)])) : v;
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
const reserved = new Set(['authorization','token','apikey','api_key','secret','secretref','workspaceid','entityid','requester','invocationid','sessionid','grantref','target','headers','endpoint','url']);
export function hasReservedFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k,v]) => reserved.has(k.toLowerCase()) || hasReservedFields(v));
}
export function validateRegistry(registry: ResourceRegistry): void {
  if (!registry || !Array.isArray(registry.mcpServers)) throw new Error('Invalid host resource registry');
  validateExecutionResources(registry.executionResources);
  const names = new Set<string>();
  for (const server of registry.mcpServers) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(server.serverRef) || names.has(server.serverRef)) throw new Error('Invalid or duplicate server registration'); names.add(server.serverRef);
    const endpoint = new URL(server.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))) throw new Error('Registered MCP endpoint must use HTTPS or loopback HTTP');
    const tools = new Set<string>();
    for (const tool of server.tools) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || tools.has(tool.name) || tool.inputSchema['type'] !== 'object' || tool.inputSchema['additionalProperties'] !== false || hasReservedFields(tool.inputSchema['properties'])) throw new Error('Tool registration must have closed non-identity arguments');
      tools.add(tool.name);
    }
  }
}
export function resolveMcp(spec: ResolvedAgentSpec, registry: ResourceRegistry): RegisteredMcpServer[] {
  validateRegistry(registry);
  if (spec.role === 'interaction' && spec.mcpServers.length) throw new Error('Business MCP forbidden for interaction role');
  return spec.mcpServers.map(request => {
    if (request.secretRef) throw new Error('MCP credential injection unsupported; no fallback to ambient credentials');
    const server = registry.mcpServers.find(s => s.serverRef === request.serverRef);
    if (!server || !Array.isArray(request.allowedTools) || request.allowedTools.length === 0 || new Set(request.allowedTools).size !== request.allowedTools.length) throw new Error('MCP resource not registered');
    const tools = request.allowedTools.map(name => { const tool = server.tools.find(t => t.name === name); if (!tool) throw new Error('MCP tool not registered'); return tool; });
    return { ...server, tools };
  });
}

export interface RegisteredSkill { resourceId: string; version: string; digest: string; name: string; description: string; content: string;files?:{path:string;data:string;size:number;digest:string}[] }
/** The digest pins the entire pre-reviewed markdown snapshot, not an installable package. */
export function resolveSkills(spec: ResolvedAgentSpec, registry: ResourceRegistry): RegisteredSkill[] {
  if (spec.role === 'interaction' && spec.skills.length) throw new Error('Business skill forbidden for interaction role');
  return spec.skills.map(ref => {
    const skill = registry.skills?.find(s => s.resourceId === ref.resourceId && s.version === ref.version && s.digest.replace(/^sha256:/, '') === ref.digest.replace(/^sha256:/, ''));
    if (!skill || !/^[a-zA-Z0-9_-]{1,64}$/.test(skill.name) || skillDigest(skill) !== skill.digest.replace(/^sha256:/, '') || Buffer.byteLength(skill.content) > 65536) throw new Error('Skill registration or digest invalid');
    return skill;
  });
}

function skillDigest(skill:RegisteredSkill){if(!skill.files)return createHash('sha256').update(skill.content).digest('hex');if(skill.files.length>1000)throw new Error('Skill file limit');let total=0;const paths=new Set<string>();const manifest=skill.files.map(({data,...f})=>{const path=f.path;if(!path||path.includes('\\')||path.includes('\0')||path.startsWith('/')||/^[a-z]:/i.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||paths.has(path.normalize('NFC').toLowerCase()))throw new Error('Unsafe skill path');paths.add(path.normalize('NFC').toLowerCase());const bytes=Buffer.from(data,'base64');total+=bytes.length;if(bytes.length!==f.size||f.size>20*1024*1024||total>100*1024*1024||createHash('sha256').update(bytes).digest('hex')!==f.digest)throw new Error('Skill file digest invalid');return f;});const main=skill.files.find(f=>f.path==='SKILL.md');if(!main||Buffer.from(main.data,'base64').toString('utf8')!==skill.content)throw new Error('Skill main document invalid');return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');}
