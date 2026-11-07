export interface WireCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface WireMessage { role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: string; toolCalls: WireCall[]; toolCallId?: string }
export interface WireTool { name: string; logicalName: string; description: string; parameters: Record<string, unknown> }
export interface CompletionRequest {
  /** Whitelisted synthetic observation only; missing remains distinguishable from false. */
  reasoningEffort?: 'none'|'low'|'medium'|'high'; enableThinking?: false;
  model: string; messages: WireMessage[]; tools: WireTool[]; stream: boolean; includeUsage: boolean;
  toolChoice: 'auto' | 'none' | 'required' | { name: string }; maxOutputTokens: number;
}
export type Phase = 'probe' | 'summary' | 'interaction' | 'execution';
export interface ToolExchange { call: WireCall; name: string; content: string; failed: boolean }
export interface RuleContext {
  request: CompletionRequest; phase: Phase; input: string; turn: WireMessage[];
  exchanges: ToolExchange[]; latestExchange?: ToolExchange;
}
export interface RuleOutput { text: string; calls?: { name: string; arguments: Record<string, unknown> }[]; fault?: 'invalid_arguments' | 'incomplete_stream'; delayMs?: number }
export interface Rule {
  id: string; priority: number; phase: Phase; exact?: string; keywords?: readonly string[];
  requiredTools?: readonly string[]; forbiddenTools?: readonly string[]; afterTool?: string;
  when?: (context: RuleContext) => boolean; output: RuleOutput | ((context: RuleContext) => RuleOutput);
}
export interface Completion { ruleId: string; model: string; text: string; calls: WireCall[]; inputTokens: number; outputTokens: number; fault?: RuleOutput['fault']; delayMs: number }
export class ModelError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const fail = (status: number, code: string): never => { throw new ModelError(status, code); };
