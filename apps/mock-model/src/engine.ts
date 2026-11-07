import { createHash } from 'node:crypto';
import { DEFAULT_RULES } from './scenarios/default.js';
import { fail, type Completion, type CompletionRequest, type Rule, type RuleContext, type RuleOutput, type ToolExchange } from './types.js';
export const MODEL_IDS = ['mock','mock-error','mock-incomplete-stream','mock-invalid-tool-arguments','mock-delay','mock-mcp-forbidden'] as const;
function failed(content: string, name: string): boolean {
  if (/^(?:Error:|error:|Tool failed|Permission denied)/.test(content.trim()) || /Command (?:exited with code [1-9]|timed out|terminated)/.test(content)) return true;
  try { const raw: unknown = JSON.parse(content); if (raw && typeof raw === 'object' && !Array.isArray(raw)) { const value = raw as Record<string,unknown>; return value['isError'] === true || value['error'] !== undefined && value['error'] !== null || !['task_query','task_query_results'].includes(name) && ['failed','rejected','denied','unknown'].includes(String(value['status'])) || typeof value['exit_code'] === 'number' && value['exit_code'] !== 0; } } catch { /* Plain tool text is valid. */ }
  return false;
}
export function contextFor(request: CompletionRequest): RuleContext {
  const lastUser = request.messages.findLastIndex(m => m.role === 'user');
  if (lastUser < 0) return fail(422,'mock_user_input_required');
  const latestInput = request.messages[lastUser]!.content.trim();
  const summary = request.messages.some(m => ['system','developer'].includes(m.role) && m.content.startsWith('Produce a concise factual memory summary, not a reply or an action.'));
  const hasInteraction = request.tools.some(t=>t.logicalName.startsWith('task_') || t.logicalName === 'capability.list');
  const hasExecution = request.tools.some(t=>['write','read','bash','edit','context_read','progress_report'].includes(t.logicalName));
  const phase = summary ? 'summary' : latestInput === 'Reply OK.' && lastUser === request.messages.length - 1 && !request.tools.length ? 'probe' : hasInteraction || !hasExecution ? 'interaction' : 'execution';
  // A running pi invocation can insert steering user messages between tool batches.
  // Its earlier receipts remain execution facts; starting over would repeat side effects.
  // Interaction intentionally uses only its current turn to avoid reusing an old intent.
  const turn = request.messages.slice(phase === 'execution' ? request.messages.findIndex(m => m.role === 'user') : lastUser);
  const rawInput = turn[0]!.content.trim();
  // Channel labels describe the speaker; they are not the rule's user intent.
  // Strip leading bounded key=value labels only for interaction matching. Original messages,
  // execution instructions and summary inputs retain their complete contents.
  // This test service never derives authorization from a text label.
  const input = phase === 'interaction'
    ? rawInput.replace(/^(?:\[[^\[\]=\r\n]{1,32}=[^\[\]\r\n]{0,160}\][ \t]*){1,16}/, '').trim()
    : rawInput;
  const calls = new Map<string,{name:string;call:import('./types.js').WireCall}>(); const exchanges: ToolExchange[] = [];
  for (const message of turn) {
    for (const call of message.toolCalls) calls.set(call.id,{ name: request.tools.find(t=>t.name===call.function.name)?.logicalName ?? call.function.name, call });
    if (message.role === 'tool') { const prior = calls.get(message.toolCallId!); if (!prior) return fail(400,'orphan_tool_result'); exchanges.push({ ...prior, content: message.content, failed: failed(message.content,prior.name) }); }
  }
  const latestExchange = exchanges.at(-1);
  return { request, phase, input, turn, exchanges, ...(latestExchange ? { latestExchange } : {}) };
}
export function validateRules(rules: readonly Rule[]): Rule[] {
  const ids = new Set<string>(); const exacts = new Set<string>();
  for (const rule of rules) {
    if (!/^[a-z][a-z0-9.-]{1,100}$/.test(rule.id) || ids.has(rule.id) || !Number.isSafeInteger(rule.priority) || !['probe','summary','interaction','execution'].includes(rule.phase)) return fail(500,'mock_rule_configuration_invalid');
    if (typeof rule.output !== 'function' && (!rule.output || typeof rule.output.text !== 'string' || Buffer.byteLength(rule.output.text) > 65536 || rule.output.calls?.some(c=>typeof c.name !== 'string' || !c.name || !c.arguments || typeof c.arguments !== 'object' || Array.isArray(c.arguments)))) return fail(500,'mock_rule_configuration_invalid');
    ids.add(rule.id);
    if (rule.exact !== undefined) { const key=JSON.stringify([rule.phase,rule.priority,rule.exact]); if (!rule.exact || exacts.has(key)) return fail(500,'mock_rule_conflict'); exacts.add(key); }
    if (rule.keywords?.some(k=>!k) || rule.requiredTools?.some(t=>rule.forbiddenTools?.includes(t))) return fail(500,'mock_rule_configuration_invalid');
  }
  return [...rules].sort((a,b)=>b.priority-a.priority || a.id.localeCompare(b.id,'en'));
}
export function createRuleEngine(rules: readonly Rule[] = DEFAULT_RULES): (request: CompletionRequest) => Completion {
  const sorted = validateRules(rules);
  return request => {
    const requestedModel=request.model;
    const legacy=requestedModel==='dentity-local-rules'||requestedModel.startsWith('dentity-local-rules-');
    const model=legacy?requestedModel.replace('dentity-local-rules','mock'):requestedModel;
    request={...request,model};
    if (!(MODEL_IDS as readonly string[]).includes(request.model)) return fail(404,'mock_model_not_found');
    if (request.model === 'mock-error') return fail(503,'mock_injected_provider_error');
    if (!request.stream && request.model === 'mock-incomplete-stream') return fail(400,'mock_fault_requires_stream');
    const c = contextFor(request); const names = new Set(request.tools.map(t=>t.logicalName));
    // Explicit local fault model: fixed test names only, never an arbitrary tool override.
    const mcpFault=request.model==='mock-mcp-forbidden'&&c.phase==='execution'&&c.input.includes('体验MCP');
    const testNames=['mcp__local_mock_alpha__lookup','mcp__local_mock_beta__lookup'];
    const missing=mcpFault?testNames.find(name=>!names.has(name)):undefined;
    if(mcpFault&&!missing)return fail(422,'mock_fault_requires_missing_mcp');
    const match = mcpFault ? {id:'execution.mcp-forbidden',output:c.exchanges.some(e=>e.name===missing)?{text:'本地故障验收：pi 已拒绝未注册 MCP 工具；以原生工具错误和 MCP 调用日志为准。'}:{text:'',calls:[{name:missing!,arguments:{}}]}} : sorted.find(rule => rule.phase === c.phase && (rule.exact === undefined || rule.exact === c.input) && (!rule.keywords || rule.keywords.every(word=>c.input.includes(word))) && (!rule.requiredTools || rule.requiredTools.every(name=>names.has(name))) && (!rule.forbiddenTools || rule.forbiddenTools.every(name=>!names.has(name))) && (!rule.afterTool || c.latestExchange?.name === rule.afterTool) && (!rule.when || rule.when(c)));
    if (!match) return fail(422,'mock_rule_not_matched');
    const output: RuleOutput = typeof match.output === 'function' ? match.output(c) : match.output;
    if (typeof output.text !== 'string' || Buffer.byteLength(output.text) > 65536) return fail(422,'mock_output_limit_exceeded');
    const seed = createHash('sha256').update(JSON.stringify(request.messages)).update(match.id).digest('hex').slice(0,24);
    const calls = (output.calls ?? []).map((item,index)=>{
      const tool = request.tools.find(t=>t.logicalName === item.name);
      if (!tool && !(mcpFault && item.name===missing)) return fail(422,'mock_required_tool_unavailable');
      return { id: `call_local_${seed}_${index}`, type: 'function' as const, function: { name: tool?.name??missing!, arguments: JSON.stringify(item.arguments) } };
    });
    if (calls.length > 1) return fail(422,'mock_parallel_calls_unsupported');
    if (request.toolChoice === 'none' && calls.length || request.toolChoice === 'required' && !calls.length || typeof request.toolChoice === 'object' && (!calls.length || calls.some(call=>call.function.name !== (request.toolChoice as {name:string}).name))) return fail(422,'mock_tool_choice_not_satisfied');
    if (Buffer.byteLength(JSON.stringify([output.text,calls])) > 65536) return fail(422,'mock_output_limit_exceeded');
    const outputTokens = Math.max(1,Math.ceil(Buffer.byteLength(output.text+calls.map(call=>call.function.arguments).join(''))/4));
    if (outputTokens > request.maxOutputTokens) return fail(422,'mock_output_budget_exceeded');
    const fault = request.model === 'mock-incomplete-stream' ? 'incomplete_stream' : request.model === 'mock-invalid-tool-arguments' ? 'invalid_arguments' : output.fault;
    if (fault === 'invalid_arguments' && !calls.length) return fail(422,'mock_fault_requires_tool_call');
    return { ruleId: match.id, model: requestedModel, text: output.text, calls, inputTokens: Math.max(1,Math.ceil(Buffer.byteLength(JSON.stringify(request.messages))/4)), outputTokens, ...(fault ? { fault } : {}), delayMs: request.model === 'mock-delay' ? 200 : output.delayMs ?? 0 };
  };
}
