import{HUMAN_RULES}from'./human.js';
import { createHash } from 'node:crypto';
import { fail, type Rule, type RuleContext, type RuleOutput } from '../types.js';
export const ARTICLE_NAME = 'article.md';
export const ARTICLE_CONTENT = '# 本地规则模型测试文章\n\n这份 Markdown 由真实 pi 文件工具生成，用于验证平台任务、运行与投递链路。\n\n## 验证内容\n\n- 工具执行受到实际授权约束。\n- 任务进度与最终结果持久化。\n- 所有测试产物仅位于隔离执行目录。\n';
export const ARTICLE_RESULT = 'Markdown 文章已生成：article.md。文件由真实 write 工具写入，并经 read 与 Bash 核验；详细进度和最终状态以平台任务记录为准。';
export const ARTICLE_STEER_MARKER = '慢工具追加验证';
export const ARTICLE_STEER_READY = '.article-steer-ready';
export const ARTICLE_STEER_CONTINUE = '.article-steer-continue';
const call = (name: string, args: Record<string, unknown>, text = ''): RuleOutput => ({ text, calls: [{ name, arguments: args }] });
const exchangesFor = (c: RuleContext, name: string) => c.exchanges.filter(e => e.name === name);
function taskFact(content: string): { id: string; status?: string; result?: string } | undefined {
  try {
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>;
    if (typeof value['id'] !== 'string' || !value['id'] || value['id'].length > 160) return;
    const run=value['run'];
    const result=typeof value['result']==='string'?value['result']:run&&typeof run==='object'&&!Array.isArray(run)?(run as Record<string,unknown>)['result']:undefined;
    return { id: value['id'], ...(typeof value['status'] === 'string' ? { status: value['status'] } : {}), ...(typeof result === 'string' ? { result } : {}) };
  } catch { return; }
}
function summarize(c: RuleContext): RuleOutput {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(c.input) as Record<string, unknown>; } catch { return fail(422, 'mock_summary_input_invalid'); }
  const digest = createHash('sha256').update(c.input).digest('hex').slice(0,16);
  const kind = parsed['kind'] === 'historical_rollup' ? '历史汇总' : parsed['kind'] === 'shorten_memory_preserving_constraints' ? '缩短摘要' : '逐日摘要';
  const records = Array.isArray(parsed['records']) ? parsed['records'] : [];
  const facts = records.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const m = (raw as Record<string, unknown>)['message'];
    if (!m || typeof m !== 'object') return [];
    const content = (m as Record<string, unknown>)['content'];
    return typeof content === 'string' ? [content.replace(/\s+/g,' ').slice(0,120)] : [];
  });
  const prior = typeof parsed['previous'] === 'string' ? parsed['previous'] : typeof parsed['summary'] === 'string' ? parsed['summary'] : '';
  const prefix = `${kind} [${digest}]：`;
  const candidates = `${prefix}${facts.length ? facts.join('；') : prior || '规则测试来源已归纳，未推断新的完成或授权事实。'}`;
  const maxBytes = Math.min(c.request.maxOutputTokens*4, typeof parsed['maxUtf8Bytes'] === 'number' ? parsed['maxUtf8Bytes'] : 4000);
  if (maxBytes < Buffer.byteLength(prefix)+4) return fail(422, 'mock_summary_budget_too_small');
  let text = ''; for (const char of candidates) { if (Buffer.byteLength(text+char) > maxBytes) break; text += char; }
  return { text };
}
const isArticle = (c: RuleContext) => /(?:帮我写一个\s*md\s*文章|写(?:一篇|一个)?.*(?:Markdown|markdown|md文章)|本地规则模型测试文章)/.test(c.input);
const has = (c: RuleContext, name: string) => c.request.tools.some(t => t.logicalName === name);
const requestedMcp = (c: RuleContext) => {
  const label=c.input.includes('体验MCP甲')?'alpha':c.input.includes('体验MCP乙')?'beta':undefined;
  if(!label)return;
  // Synthetic service descriptions identify the local fixture, never grant access.
  // The selected name must already exist in this request's authorized tool set.
  return c.request.tools.find(t=>/^mcp__ws_mcp_[a-f0-9]{32}__lookup$/.test(t.logicalName)&&[`Local synthetic ${label} business lookup`,`QA ${label} business lookup`].includes(t.description))?.logicalName??`mcp__local_mock_${label}__lookup`;
};
export const DEFAULT_RULES: readonly Rule[] = [
  {id:'interaction.business-notice',priority:900,phase:'interaction',when:c=>c.request.toolChoice==='none'&&c.input.startsWith('Runtime business result data for this conversation.'),output:c=>{try{const data=JSON.parse(c.input.slice(c.input.indexOf('\n')+1))as{facts?:{result?:unknown;status?:string}};const result=data.facts?.result;return{text:typeof result==='string'&&result.trim()?result:data.facts?.status==='failed'?'后台任务执行失败，请查看任务记录。':'业务状态已更新，请查看记录。'};}catch{return fail(422,'mock_business_event_invalid');}}},
  ...HUMAN_RULES,
  { id: 'probe.ok', priority: 1000, phase: 'probe', exact: 'Reply OK.', output: { text: 'OK.' } },
  { id: 'summary.memory', priority: 900, phase: 'summary', when: c => {
    try { const value = JSON.parse(c.input) as Record<string, unknown>; return !!value && (typeof value['date'] === 'string' && Array.isArray(value['records']) || ['historical_rollup','shorten_memory_preserving_constraints'].includes(String(value['kind']))); } catch { return false; }
  }, output: summarize },
  { id: 'interaction.tool-failure', priority: 1000, phase: 'interaction', when: c => !!c.latestExchange?.failed, output: { text: '平台工具没有成功，任务状态仍以平台事实为准；请检查配置或权限后再试。' } },
  { id: 'interaction.task-accepted', priority: 800, phase: 'interaction', afterTool: 'task_create', when: c => !!taskFact(c.latestExchange!.content), output: c => {
    const task = taskFact(c.latestExchange!.content)!;
    return { text: `后台任务已受理（${task.id}）。你可以继续对话或查询进度，当前尚不能据此认定任务完成。` };
  } },
  { id: 'interaction.task-status', priority: 800, phase: 'interaction', when: c => ['task_query','task_query_results'].includes(c.latestExchange?.name ?? '') && !!taskFact(c.latestExchange!.content), output: c => {
    const task = taskFact(c.latestExchange!.content)!;
    return { text: `任务 ${task.id} 当前状态：${task.status ?? 'unknown'}。${task.result ? `平台结果：${task.result}` : '尚未取得平台结果，不推断完成。'}` };
  } },
  { id: 'interaction.greeting', priority: 500, phase: 'interaction', exact: '你好', when: c => !c.latestExchange, output: { text: '你好。我可以帮你做什么' } },
  { id: 'interaction.article-exact', priority: 500, phase: 'interaction', exact: '帮我写一个md文章', requiredTools: ['task_create'], when: c => !c.latestExchange, output: c => call('task_create', {input:c.input}) },
  { id: 'interaction.article-keywords', priority: 300, phase: 'interaction', keywords: ['文章'], requiredTools: ['task_create'], when: c => !c.latestExchange && isArticle(c), output: c => call('task_create', {input:c.input}) },
  { id: 'interaction.query-task', priority: 400, phase: 'interaction', requiredTools: ['task_query'], when: c => !c.latestExchange && /进度|任务结果|完成了吗|查询任务/.test(c.input), output: c => {
    const calls = new Map<string,string>(); let latest: ReturnType<typeof taskFact>;
    for (const message of c.request.messages) {
      for (const item of message.toolCalls) calls.set(item.id,item.function.name);
      if (message.role === 'tool') { const wire = calls.get(message.toolCallId!); const logical = c.request.tools.find(t=>t.name === wire)?.logicalName; if (logical === 'task_create' || logical === 'task_query' || logical === 'task_query_results') latest = taskFact(message.content) ?? latest; }
    }
    return latest ? call('task_query', { taskId: latest.id }) : { text: '请明确要查询的任务；当前会话还没有可核对的任务受理记录。' };
  } },
  { id: 'execution.tool-failure', priority: 1000, phase: 'execution', when: c => c.exchanges.some(e=>e.failed), output: () => fail(422,'mock_execution_tool_failed') },
  { id: 'execution.mcp-unavailable', priority: 900, phase: 'execution', when: c => !!requestedMcp(c) && !has(c,requestedMcp(c)!), output: { text: '所请求的本地 Mock MCP 未装配到当前 Session，无法调用；请管理员检查能力包使用范围。没有执行该 MCP 工具。' } },
  { id: 'execution.mcp-call', priority: 900, phase: 'execution', when: c => !!requestedMcp(c) && has(c,requestedMcp(c)!) && !exchangesFor(c,requestedMcp(c)!).length, output: c => call(requestedMcp(c)!,{}) },
  { id: 'execution.mcp-complete', priority: 900, phase: 'execution', when: c => !!requestedMcp(c) && !!exchangesFor(c,requestedMcp(c)!).length, output: c => ({text:`本地 Mock MCP 调用已返回：${c.latestExchange!.content}。这是一条合成测试结果，未生成文章。`}) },
  { id: 'execution.article-start', priority: 700, phase: 'execution', requiredTools: ['write'], when: c => isArticle(c) && !c.exchanges.length && has(c,'progress_report'), output: () => call('progress_report', { text: '正在隔离执行目录中生成 Markdown 文章。' }) },
  { id: 'execution.article-write', priority: 600, phase: 'execution', requiredTools: ['write'], when: c => isArticle(c) && !exchangesFor(c,'write').length && (!c.exchanges.length || c.latestExchange?.name === 'progress_report' || c.latestExchange?.name === 'context_read'), output: () => call('write', { path: ARTICLE_NAME, content: ARTICLE_CONTENT }) },
  { id: 'execution.article-read', priority: 600, phase: 'execution', requiredTools: ['read'], afterTool: 'write', when: c => isArticle(c), output: () => call('read', { path: ARTICLE_NAME }) },
  { id: 'execution.article-bash', priority: 600, phase: 'execution', requiredTools: ['bash'], afterTool: 'read', when: c => isArticle(c) && c.latestExchange!.content.includes('# 本地规则模型测试文章'), output: c => call('bash', { command: (c.input.includes(ARTICLE_STEER_MARKER) ? `touch ${ARTICLE_STEER_READY}; while [ ! -f ${ARTICLE_STEER_CONTINUE} ]; do /bin/sleep 0.1; done; ` : '') + "test -f article.md && printf 'dentity-article-verified\\n' && wc -c < article.md", timeout: c.input.includes(ARTICLE_STEER_MARKER) ? 30 : 10 }) },
  { id: 'execution.article-progress', priority: 500, phase: 'execution', requiredTools: ['progress_report'], afterTool: 'bash', when: c => isArticle(c) && c.latestExchange!.content.includes('dentity-article-verified'), output: () => call('progress_report', { text: ARTICLE_RESULT }) },
  { id: 'execution.article-complete', priority: 400, phase: 'execution', when: c => isArticle(c) && exchangesFor(c,'write').length > 0 && exchangesFor(c,'read').some(e=>e.content.includes('# 本地规则模型测试文章')) && exchangesFor(c,'bash').some(e=>e.content.includes('dentity-article-verified')) && (c.latestExchange?.name === 'progress_report' || !has(c,'progress_report')), output: { text: ARTICLE_RESULT } },
];
