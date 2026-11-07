import { computed, onUnmounted, ref, watch } from 'vue';
import{openWhenConfigured}from'./conversation-opening';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { Entity, Workspace } from '../../shared/api';
import type { ChatMode } from '../../phase2';

const memoryDrafts=new Map<string,string>();
export function useConversationSession(props: { entity: Entity; workspace: Workspace; initialConversationId?: string | undefined; initialMode?: ChatMode | undefined }, emit: { (event: 'close' | 'sessionExpired' | 'editSettings'): void; (event: 'entityUpdated', entity: Entity): void; (event: 'conversationSelected', id: string): void }) {
interface Conversation { id: string; mode: ChatMode; simulated: boolean; createdAt: number }
interface Message { id: string; role: 'user' | 'assistant'; text: string; simulated: boolean; createdAt: number; source?: 'task_delivery' }
interface Turn { id: string; status: string; mode: ChatMode; simulated: boolean; text?: string; error?: string;replyId?:string }
const base = computed(() => `/workspaces/${encodeURIComponent(props.workspace.id)}/entities/${encodeURIComponent(props.entity.id)}`);
const canManageEntity = computed(() => true);
const conversation = ref<Conversation | null>(null);
const messages = ref<Message[]>([]), text = ref(''), error = ref(''), notice = ref('');
const continuationAllowed=ref(true),readOnlyReason=ref('');
const pendingTurns=ref<Turn[]>([]);let polling=false;
const busy = ref(false), turn = ref<Turn | null>(null), interrupting = ref(false), loaded = ref(false);
const historicalReadOnly = computed(() => conversation.value?.mode === 'demo' || conversation.value?.simulated === true);
const generating = computed(() => !historicalReadOnly.value && pendingTurns.value.some(t=>!['succeeded','failed','canceled','unknown'].includes(t.status)));
const realHistory = computed(() => messages.value.filter(m => !m.simulated && m.source !== 'task_delivery'));
let controller = new AbortController(), version = 0,currentDraftKey='';
const draftKey=()=>JSON.stringify([props.workspace.id,props.workspace.memberId,props.entity.id]);
function retainDraft(){if(currentDraftKey){if(text.value)memoryDrafts.set(currentDraftKey,text.value);else memoryDrafts.delete(currentDraftKey);}}
let timer: ReturnType<typeof setTimeout> | undefined;
let messageLoad=0,pollError='';
const operations = new Map<string, string>(), knownTurns = new Map<string, Turn>();
function reset() {
  version++;messageLoad++;pollError='';pendingTurns.value=[];polling=false; controller.abort(); controller = new AbortController(); if (timer) clearTimeout(timer);
  continuationAllowed.value=true;readOnlyReason.value='';conversation.value = null; messages.value = []; turn.value = null; text.value = ''; busy.value = false; interrupting.value = false; error.value = ''; notice.value = '';
}
function report(cause: unknown, expected: number) {
  if (expected !== version || controller.signal.aborted) return;
  error.value = errorMessage(cause);
  if (cause instanceof ApiError && [401, 403].includes(cause.status)) { messages.value = []; conversation.value = null; turn.value = null; controller.abort(); if (timer) clearTimeout(timer); }
  if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
}
async function loadMessages(expected: number) {
  if (expected !== version) return;
  const id = conversation.value?.id;
  if (!id) return;
  const request=++messageLoad;
  const result = await api<{ messages: Message[] }>(`${base.value}/conversations/${encodeURIComponent(id)}/messages`, controller.signal);
  if (expected === version && conversation.value?.id === id && request===messageLoad) messages.value = result.messages;
}
function schedulePoll(expected:number,id:string) {
  if(expected!==version||controller.signal.aborted||!loaded.value||conversation.value?.id!==id||historicalReadOnly.value)return;
  if(timer)clearTimeout(timer);
  // Completion notices are independent of the input turn and may arrive long after it ends.
  const delay=document.visibilityState==='visible'?(generating.value?2000:5000):10000;
  timer=setTimeout(()=>void pollTurn(expected,id,''),delay);
}
async function pollTurn(expected:number,conversationId:string,_turnId:string){
  if(expected!==version||controller.signal.aborted||polling||conversation.value?.id!==conversationId||historicalReadOnly.value)return;if(timer)clearTimeout(timer);polling=true;
  try{
    for(const item of [...pendingTurns.value]){
      if(['succeeded','failed','canceled','unknown'].includes(item.status))continue;
      const result=await api<{turn:Turn}>(`${base.value}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(item.id)}`,controller.signal);
      if(expected!==version)return;
      pendingTurns.value=pendingTurns.value.map(t=>t.id===item.id?result.turn:t);
      if(turn.value?.id===item.id){turn.value=result.turn;knownTurns.set(conversationId,result.turn);if(result.turn.error)error.value=result.turn.error;}
      if(result.turn.status==='unknown')notice.value='本条输入结果未知；临时排队可能因服务重启丢失，请核对后重试。';
    }
    await loadMessages(expected);
    if(expected===version){if(pollError&&error.value===pollError)error.value='';pollError='';}
  }catch(cause){report(cause,expected);if(expected===version)pollError=error.value;}
  finally{if(expected===version){polling=false;schedulePoll(expected,conversationId);}}
}
async function send() {
  const record = conversation.value;
  if (!record || !continuationAllowed.value || historicalReadOnly.value || busy.value || !text.value.trim()) return;
  const expected = version; busy.value = true; error.value = ''; notice.value = '';
  const content = text.value, key = `${record.id}:${content}`;
  if (!operations.has(key)) operations.set(key, crypto.randomUUID());
  try {
    const result = await api<{ turn: Turn }>(`${base.value}/conversations/${encodeURIComponent(record.id)}/turns`, controller.signal, { operationId: operations.get(key), text: content });
    if (expected !== version) return;
    operations.delete(key); text.value = ''; turn.value = result.turn;pendingTurns.value.push(result.turn);if(result.turn.status==='queued')notice.value='消息已排队，将在当前工具结果返回后消费；尚未回答。'; knownTurns.set(record.id, result.turn);
    await loadMessages(expected);
    if (expected === version) void pollTurn(expected, record.id, result.turn.id);
  } catch (cause) { report(cause, expected); const rejected=cause instanceof ApiError&&cause.status>=400&&cause.status<500&&cause.code!=='TIMEOUT_UNKNOWN';if(rejected)operations.delete(key);if (expected === version) notice.value = rejected ? '本次发送已被明确拒绝，原文已保留。请先处理所示错误；未自动重试或重新创建任务。' : '发送未确认。保留原文重试会复用同一操作标识；请先核对消息和任务状态。'; }
  finally { if (expected === version) busy.value = false; }
}
async function interrupt() {
  const record = conversation.value, activeTurn = turn.value;
  if (!record || historicalReadOnly.value || !activeTurn || interrupting.value) return;
  const expected = version; interrupting.value = true;
  try {
    const result = await api<{ status: 'requested' | 'unknown' }>(`${base.value}/conversations/${encodeURIComponent(record.id)}/turns/${encodeURIComponent(activeTurn.id)}/interrupt`, controller.signal, {});
    if (expected === version) notice.value = result.status === 'requested' ? '已申请中断回复，等待确认。此操作不取消任何后台业务任务。' : '中断结果未知，请继续查询；后台任务不会自动取消。';
  } catch (cause) { report(cause, expected); } finally { if (expected === version) interrupting.value = false; }
}
async function refresh() { const expected = version; try { await loadMessages(expected); } catch (cause) { report(cause, expected); } }
async function initialize() {
  retainDraft();reset();currentDraftKey=draftKey();text.value=memoryDrafts.get(currentDraftKey)??''; loaded.value = false; operations.clear(); knownTurns.clear();
  const expected = version; busy.value = true;
  try {
    const result=props.initialConversationId?await api<{conversation:Conversation;canSend?:boolean;reason?:string|null}>(`${base.value}/conversations/${encodeURIComponent(props.initialConversationId)}`,controller.signal):await openWhenConfigured(signal=>api<{conversation:Conversation;canSend?:boolean;reason?:string|null}>(`${base.value}/conversations`,signal,{mode:'real'}),controller.signal,()=>{if(expected===version)notice.value='员工配置正在同步，正在自动尝试打开对话…';});
    if (expected !== version) return;
    notice.value='';
    continuationAllowed.value=result.canSend!==false;readOnlyReason.value=result.reason?errorMessage(new ApiError(result.reason,409)):'';
    conversation.value = result.conversation; loaded.value = true;
    emit('conversationSelected', result.conversation.id);
    await loadMessages(expected);
    schedulePoll(expected,result.conversation.id);
  } catch (cause) { if(expected===version)notice.value='';report(cause, expected); }
  finally { if (expected === version) busy.value = false; }
}
watch(() => [props.workspace.id, props.entity.id, props.initialConversationId, props.initialMode], (next, previous) => {
  // A route update for the conversation we just opened must not abort its fetch or active polling.
  if (previous && next[0] === previous[0] && next[1] === previous[1] && next[2] === conversation.value?.id && next[3] === previous[3]) return;
  void initialize();
}, { immediate: true });
function beforeUnload(event:BeforeUnloadEvent){if(text.value.trim()){event.preventDefault();event.returnValue='';}}
function refreshWhenAvailable(){if(document.visibilityState==='visible'&&conversation.value&&loaded.value)void pollTurn(version,conversation.value.id,'');}
window.addEventListener('online',refreshWhenAvailable);
document.addEventListener('visibilitychange',refreshWhenAvailable);
window.addEventListener('beforeunload',beforeUnload);
onUnmounted(() => { window.removeEventListener('online',refreshWhenAvailable);document.removeEventListener('visibilitychange',refreshWhenAvailable);window.removeEventListener('beforeunload',beforeUnload);retainDraft();reset(); operations.clear(); knownTurns.clear(); });
return { base, continuationAllowed,readOnlyReason, canManageEntity, conversation, messages, text, error, notice, busy, turn, interrupting, loaded, generating, realHistory, historicalReadOnly, send, interrupt, refresh, reopen:initialize };
}
