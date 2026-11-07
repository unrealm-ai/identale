import { createHash } from 'node:crypto';
import { fail, type Completion, type CompletionRequest, type WireCall, type WireMessage, type WireTool } from './types.js';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const toolName = /^[a-zA-Z0-9_.:-]{1,128}$/;
function textContent(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(item => !record(item) || !['text','input_text','output_text'].includes(String(item['type'])) || typeof item['text'] !== 'string')) return fail(400, 'unsupported_message_content');
  return value.map(item => String((item as Record<string, unknown>)['text'])).join('\n');
}
function call(value: unknown): WireCall {
  if (!record(value) || typeof value['id'] !== 'string' || !value['id'] || value['type'] !== 'function' || !record(value['function'])) return fail(400, 'invalid_tool_call');
  const fn = value['function'];
  if (typeof fn['name'] !== 'string' || !toolName.test(fn['name']) || typeof fn['arguments'] !== 'string') return fail(400, 'invalid_tool_call');
  try { JSON.parse(fn['arguments']); } catch { return fail(400, 'invalid_tool_arguments'); }
  return { id: value['id'], type: 'function', function: { name: fn['name'], arguments: fn['arguments'] } };
}
export function parseRequest(value: unknown): CompletionRequest {
  if (!record(value) || typeof value['model'] !== 'string' || !value['model'] || !Array.isArray(value['messages']) || !value['messages'].length || value['messages'].length > 2048) return fail(400, 'invalid_completion_request');
  if (value['stream'] !== undefined && typeof value['stream'] !== 'boolean') return fail(400, 'invalid_stream');
  if (value['parallel_tool_calls'] !== undefined && typeof value['parallel_tool_calls'] !== 'boolean') return fail(400, 'invalid_parallel_tool_calls');
  if (['functions','function_call','audio','modalities','stop','response_format'].some(key=>value[key] !== undefined)) return fail(400,'unsupported_completion_semantics');
  if (value['n'] !== undefined && value['n'] !== 1) return fail(400, 'unsupported_choice_count');
  if (value['reasoning_effort'] !== undefined && !['none','low','medium','high'].some(level=>level===value['reasoning_effort'])) return fail(400, 'unsupported_reasoning_effort');
  if (value['enable_thinking'] !== undefined && value['enable_thinking'] !== false) return fail(400, 'unsupported_thinking');
  if (value['stream_options'] !== undefined && (!record(value['stream_options']) || Object.keys(value['stream_options']).some(k => k !== 'include_usage') || typeof value['stream_options']['include_usage'] !== 'boolean')) return fail(400, 'invalid_stream_options');
  const messages: WireMessage[] = value['messages'].map(raw => {
    if (!record(raw) || !['system','developer','user','assistant','tool'].includes(String(raw['role']))) return fail(400, 'invalid_message_role');
    if (raw['tool_calls'] !== undefined && (raw['role'] !== 'assistant' || !Array.isArray(raw['tool_calls']) || raw['tool_calls'].length > 64)) return fail(400, 'invalid_tool_calls');
    if (raw['role'] === 'tool' && (typeof raw['tool_call_id'] !== 'string' || !raw['tool_call_id'])) return fail(400, 'tool_call_id_required');
    return { role: raw['role'] as WireMessage['role'], content: textContent(raw['content']), toolCalls: (raw['tool_calls'] as unknown[] | undefined ?? []).map(call), ...(raw['role'] === 'tool' ? { toolCallId: String(raw['tool_call_id']) } : {}) };
  });
  const pending = new Map<string, WireCall>(); const seen = new Set<string>();
  for (const message of messages) {
    for (const item of message.toolCalls) { if (seen.has(item.id)) return fail(400, 'duplicate_tool_call_id'); seen.add(item.id); pending.set(item.id, item); }
    if (message.role === 'tool') { if (!pending.delete(message.toolCallId!)) return fail(400, 'orphan_tool_result'); }
  }
  if (pending.size) return fail(400, 'tool_result_required');
  if (value['tools'] !== undefined && (!Array.isArray(value['tools']) || value['tools'].length > 128)) return fail(400, 'invalid_tools');
  const names = new Set<string>();
  const tools: WireTool[] = (value['tools'] as unknown[] | undefined ?? []).map(raw => {
    if (!record(raw) || raw['type'] !== 'function' || !record(raw['function'])) return fail(400, 'unsupported_tool_type');
    const fn = raw['function'];
    if (typeof fn['name'] !== 'string' || !toolName.test(fn['name']) || names.has(fn['name']) || !record(fn['parameters']) || fn['parameters']['type'] !== 'object' || fn['description'] !== undefined && typeof fn['description'] !== 'string') return fail(400, 'invalid_tool_definition');
    names.add(fn['name']); const description = String(fn['description'] ?? '');
    return { name: fn['name'], logicalName: fn['name'], description, parameters: fn['parameters'] };
  });
  let toolChoice: CompletionRequest['toolChoice'] = 'auto'; const choice = value['tool_choice'];
  if (choice !== undefined) {
    if (choice === 'auto' || choice === 'none' || choice === 'required') toolChoice = choice;
    else if (record(choice) && choice['type'] === 'function' && record(choice['function']) && typeof choice['function']['name'] === 'string' && names.has(choice['function']['name'])) toolChoice = { name: choice['function']['name'] };
    else return fail(400, 'invalid_tool_choice');
  }
  if (toolChoice === 'required' && !tools.length) return fail(400, 'tool_choice_requires_tools');
  const max = value['max_completion_tokens'] ?? value['max_tokens'] ?? 4096;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > 128000) return fail(400, 'invalid_output_limit');
  return { ...(value['reasoning_effort']===undefined?{}:{reasoningEffort:value['reasoning_effort'] as NonNullable<CompletionRequest['reasoningEffort']>}), ...(value['enable_thinking']===undefined?{}:{enableThinking:false}), model: value['model'], messages, tools, stream: value['stream'] === true, includeUsage: record(value['stream_options']) && value['stream_options']['include_usage'] === true, toolChoice, maxOutputTokens: max };
}
export function completionIdentity(c: Completion): string { return `chatcmpl-local-${createHash('sha256').update(JSON.stringify([c.model,c.ruleId,c.text,c.calls])).digest('hex').slice(0,24)}`; }
const usage = (c: Completion) => ({ prompt_tokens: c.inputTokens, completion_tokens: c.outputTokens, total_tokens: c.inputTokens+c.outputTokens });
export function jsonCompletion(c: Completion): object {
  return { id: completionIdentity(c), object: 'chat.completion', created: 0, model: c.model, choices: [{ index: 0, message: { role: 'assistant', content: c.text || null, ...(c.calls.length ? { tool_calls: c.calls } : {}) }, finish_reason: c.calls.length ? 'tool_calls' : 'stop' }], usage: usage(c) };
}
export function* sseCompletion(c: Completion, includeUsage: boolean): Generator<string> {
  const base = { id: completionIdentity(c), object: 'chat.completion.chunk', created: 0, model: c.model };
  const frame = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  yield frame({ role: 'assistant', content: '' });
  for (const part of Array.from(c.text).reduce<string[]>((parts, char, index) => { const i = Math.floor(index/8); parts[i] = (parts[i] ?? '')+char; return parts; }, [])) yield frame({ content: part });
  for (const [index, item] of c.calls.entries()) {
    yield frame({ tool_calls: [{ index, id: item.id, type: 'function', function: { name: item.function.name, arguments: '' } }] });
    const args = c.fault === 'invalid_arguments' ? '{invalid' : item.function.arguments;
    for (let offset=0; offset<args.length; offset+=7) yield frame({ tool_calls: [{ index, function: { arguments: args.slice(offset,offset+7) } }] });
  }
  if (c.fault === 'incomplete_stream') return;
  yield frame({}, c.calls.length ? 'tool_calls' : 'stop');
  if (includeUsage) yield `data: ${JSON.stringify({ ...base, choices: [], usage: usage(c) })}\n\n`;
  yield 'data: [DONE]\n\n';
}
