import { createBashTool, createReadTool, createWriteTool, createEditTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { LocalToolError } from './local-tool-errors.js';
import { LocalToolRuntime } from './local-tool-runtime.js';
import type { ResolvedExecutionResource, StandardToolName } from './execution-resources.js';

/** Preserve native pi schemas; local tools assign cwd without a security sandbox. */
export async function createLocalTools(resource: ResolvedExecutionResource, beforeTool?: (name: string) => Promise<void>, onUnknown?: (name: string) => Promise<void>) {
  const runtime = new LocalToolRuntime(resource);
  await runtime.initialize();
  const native = [createReadTool(resource.directory), createWriteTool(resource.directory), createEditTool(resource.directory), createBashTool(resource.directory, { exposeSessionEnvironment: false })];
  const tools = native.filter(tool => resource.tools.includes(tool.name as StandardToolName)).map(tool => ({
    name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
    executionMode: 'sequential' as const,
    async execute(callId: string, args: unknown, signal?: AbortSignal) {
      if (!beforeTool) throw new Error('Standard tools require current host authorization');
      await beforeTool(tool.name);
      try { return await runtime.execute(tool.name as StandardToolName, callId, args, signal) as Awaited<ReturnType<ToolDefinition['execute']>>; }
      catch (error) { if (error instanceof LocalToolError && error.outcome === 'unknown') await onUnknown?.(tool.name); throw error; }
    },
  })) as ToolDefinition[];
  return { tools, close: () => runtime.close() };
}
