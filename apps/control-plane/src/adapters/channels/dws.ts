import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  assertChannelResource, ChannelError,
  type ChannelConnection, type ChannelResourceRef, type ChannelQuery, type ChannelPage,
  type ConversationPort, type ConversationCapabilities, type ChannelConversation,
  type ChannelMessage, type SendChannelMessage, type ChannelSendReceipt,
  type MeetingArtifactsPort, type MeetingArtifactCapabilities, type MeetingArtifact,
  type TranscriptSegment, type MeetingSummary, type ChannelActor,
} from '@dentity/application';
import { object, array, string, optionalString } from './http.js';
import { ChannelCursorCodec, channelCursorScope } from './cursor.js';

export interface DwsReaderOptions {
  /** Operator-provisioned official CLI binary, never a model/request parameter. */
  executable: string;
  /** Isolated directory with an already authorized DWS account; no login is performed here. */
  configDirectory: string;
  workingDirectory: string;
  profile: string;
  authorizedConversationIds?: readonly string[];
  authorizedMinuteIds?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}
const unsupported = {supported:false, availability:'unsupported'} as const;
const implemented = (authorized: boolean) => ({supported:true, availability:authorized ? 'available' as const : 'authorization_required' as const});
const badShape = (): never => { throw new ChannelError('temporarily_unavailable', 'dws_response_contract_mismatch'); };
function id(value: string): string {
  if (!value || value.length > 2048 || value.startsWith('-') || /[\x00-\x20]/.test(value)) throw new ChannelError('invalid_request', 'invalid_dws_identifier');
  return value;
}
function optionalMillis(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) return badShape();
  return result;
}
function messageTime(value: unknown): number {
  if (typeof value === 'number') return optionalMillis(value)!;
  if (typeof value !== 'string') return badShape();
  if (/^\d+$/.test(value)) return optionalMillis(value)!;
  // DWS's documented local display time is CST, not the control-plane host timezone.
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}+08:00` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return badShape();
  const result = Date.parse(text); if (!Number.isSafeInteger(result)) return badShape(); return result;
}
function version(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function unwrap(envelope: Record<string, unknown>): Record<string, unknown> {
  if (envelope.outcome && envelope.outcome !== 'success') throw new ChannelError(envelope.outcome === 'partial_failure' ? 'partial_failure' : 'temporarily_unavailable', 'dws_command_failed');
  return object(envelope.data);
}
/** Fixed read-only commands. No shell, ambient environment, login, arbitrary tool or file output. */
class DwsReader {
  readonly now: () => number;
  readonly connection: ChannelConnection;
  private readonly conversations: ReadonlySet<string>;
  private readonly minutes: ReadonlySet<string>;
  private readonly options: Readonly<DwsReaderOptions>;
  constructor(connection: ChannelConnection, options: DwsReaderOptions) {
    if (connection.provider !== 'dingtalk' || connection.identity.kind !== 'delegated_user') throw new ChannelError('invalid_request', 'dws_requires_delegated_user');
    if (!isAbsolute(options.executable) || !isAbsolute(options.configDirectory) || !isAbsolute(options.workingDirectory)) throw new ChannelError('invalid_request', 'dws_paths_must_be_absolute');
    if (options.profile !== `${connection.tenantId}:${connection.identity.externalId}` || /[\x00-\x20]/.test(options.profile)) throw new ChannelError('forbidden', 'dws_profile_identity_mismatch');
    const timeout = options.timeoutMs ?? 30000, bytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32 * 1024 * 1024) throw new ChannelError('invalid_request', 'invalid_dws_limits');
    this.connection = Object.freeze({...connection, identity:Object.freeze({...connection.identity})});
    this.options = Object.freeze({...options, timeoutMs:timeout, maxOutputBytes:bytes});
    this.conversations = new Set(options.authorizedConversationIds ?? []);
    this.minutes = new Set(options.authorizedMinuteIds ?? []);
    this.now = options.now ?? Date.now;
  }
  authorized(ref: ChannelResourceRef | undefined, kind: 'conversation' | 'minutes'): boolean {
    if (ref) assertChannelResource(this.connection, ref);
    const set = kind === 'conversation' ? this.conversations : this.minutes;
    return ref ? (kind === 'conversation' ? ref.kind === 'conversation' : ['minutes','summary','transcript'].includes(ref.kind)) && set.has(ref.externalId) : set.size > 0;
  }
  require(ref: ChannelResourceRef, kind: 'conversation' | 'minutes'): void {
    assertChannelResource(this.connection, ref); id(ref.externalId);
    if (kind === 'conversation' ? ref.kind !== 'conversation' : !['minutes','transcript','summary'].includes(ref.kind)) throw new ChannelError('unsupported', 'dws_resource_namespace_unsupported');
    if (!this.authorized(ref,kind)) throw new ChannelError('forbidden', 'dws_resource_not_authorized');
  }
  async call(command: readonly string[]): Promise<Record<string, unknown>> {
    const args = ['--profile',this.options.profile,...command,'--format','json'];
    return new Promise((resolve,reject) => {
      execFile(this.options.executable,args,{cwd:this.options.workingDirectory,
        env:{DWS_CONFIG_DIR:this.options.configDirectory,HOME:this.options.configDirectory,LANG:'C.UTF-8'},
        shell:false, killSignal:'SIGKILL', timeout:this.options.timeoutMs!, maxBuffer:this.options.maxOutputBytes!, encoding:'utf8', windowsHide:true,
      },(error,stdout) => {
        // Neither stderr nor provider error bodies are disclosed: they may contain signed URLs/secrets.
        if (error && (error.code !== 7 || error.killed || error.signal)) {
          reject(new ChannelError('temporarily_unavailable','dws_read_failed')); return;
        }
        try {
          const envelope=object(JSON.parse(stdout));
          if(error){
            // Official partial_failure uses PartialData, not a message-list payload.
            const partial=object(envelope.data);
            const succeeded=array(partial.succeeded),failed=array(partial.failed),unknown=array(partial.unknown);
            if(envelope.ok!==false||envelope.outcome!=='partial_failure'||envelope.error!==undefined||
              !Number.isSafeInteger(partial.total)||partial.total!==succeeded.length+failed.length+unknown.length||
              succeeded.length===0||failed.length+unknown.length===0) return badShape();
            reject(new ChannelError('partial_failure','dws_partial_result_not_projectable')); return;
          }
          if(envelope.ok!==true||envelope.outcome!=='success'||envelope.error!==undefined) return badShape();
          object(envelope.data); resolve(envelope);
        } catch { reject(new ChannelError('temporarily_unavailable','dws_response_contract_mismatch')); }
      });
    });
  }
}

export class DingTalkDwsConversationAdapter implements ConversationPort {
  readonly connection: ChannelConnection;
  private readonly reader: DwsReader;
  private readonly cursors = new ChannelCursorCodec();
  constructor(connection: ChannelConnection, options: DwsReaderOptions) { this.reader = new DwsReader(connection,options); this.connection = this.reader.connection; }
  async inspectCapabilities(ref?: ChannelResourceRef): Promise<ConversationCapabilities> {
    return {mentionEvents:unsupported, ordinaryMessageEvents:unsupported, historyRead:implemented(this.reader.authorized(ref,'conversation')),proactiveSend:unsupported,replyToMessage:unsupported,threadRead:unsupported};
  }
  async getConversation(ref: ChannelResourceRef): Promise<ChannelConversation> { this.reader.require(ref,'conversation'); throw new ChannelError('unsupported','dws_conversation_metadata_not_implemented'); }
  async sendMessage(request: SendChannelMessage): Promise<ChannelSendReceipt> { this.reader.require(request.conversation,'conversation'); throw new ChannelError('unsupported','dws_reader_is_read_only'); }
  async listMessages(ref: ChannelResourceRef, query: ChannelQuery): Promise<ChannelPage<ChannelMessage>> {
    this.reader.require(ref,'conversation');
    if (query.threadId) throw new ChannelError('unsupported','dws_thread_read_not_implemented');
    if (query.order !== undefined) throw new ChannelError('unsupported','dws_history_order_not_implemented');
    // Freeze query boundaries across continuation calls. No rolling "now" on page two.
    const start = query.startAt, end = query.endAt, limit = query.limit ?? 50;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 0 || end! <= start! || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ChannelError('invalid_request','dws_history_requires_bounded_range');
    const args = ['chat','+chat-messages','--group',ref.externalId,'--start',new Date(start!).toISOString(),'--end',new Date(end!).toISOString(),'--order','asc','--limit',String(limit),'--no-reactions'];
    const scope=channelCursorScope(this.connection,ref,{startAt:start!,endAt:end!,limit});
    const current=query.cursor?this.cursors.decode(scope,query.cursor):undefined;
    if(current) args.push('--page-token',id(current.token));
    const data = unwrap(await this.reader.call(args));
    if(data.contractVersion!=='im.message-list.v1')return badShape();
    const messages = array(data.messages).map((raw): ChannelMessage => {
      const m = object(raw); if (string(m.conversationId) !== ref.externalId) throw new ChannelError('forbidden','dws_conversation_mismatch');
      const externalId = optionalString(m.senderId), displayName = optionalString(m.sender);
      const threadId = optionalString(m.threadId);
      return {id:string(m.messageId),conversation:ref,text:string(m.text),occurredAt:messageTime(m.createTime),mentions:[],
        author:{kind:'unknown',identityEvidence:externalId || displayName ? 'source_label' : 'unknown',...(externalId?{externalId,idNamespace:'unknown' as const}:{}),...(displayName?{displayName}:{})},
        ...(threadId?{threadId}:{}),
      };
    });
    const failed = data.failedCount !== 0 || array(data.failures).length > 0;
    const token = optionalString(data.nextPageToken);
    if(token && token===current?.token)throw new ChannelError('partial_failure','dws_repeated_provider_cursor');
    const nextCursor=token?this.cursors.encode(scope,{token}):undefined;
    if (data.complete !== true && data.complete !== false || data.hasMore !== true && data.hasMore !== false) return badShape();
    const exhausted = data.complete === true && data.hasMore === false && !failed;
    return {items:messages,exhausted,coverage:exhausted?'authorized_query':'partial',fetchedAt:this.reader.now(),...(nextCursor?{nextCursor}:{}),warnings:[
      'history_is_authorized_query_not_complete_group_lifetime', 'thread_replies_and_mentions_not_normalized',
      ...(!exhausted&&!nextCursor?['dws_version_did_not_return_supported_continuation']:[]),
      ...(failed?['dws_partial_result']:[]),
    ]};
  }
}

/** Reads existing AI minutes only. No recording, upload, sharing or generation commands. */
export class DingTalkDwsMeetingArtifactsAdapter implements MeetingArtifactsPort {
  readonly connection: ChannelConnection;
  private readonly reader: DwsReader;
  private readonly cursors = new ChannelCursorCodec();
  constructor(connection: ChannelConnection, options: DwsReaderOptions) { this.reader = new DwsReader(connection,options); this.connection = this.reader.connection; }
  async inspectCapabilities(ref?: ChannelResourceRef): Promise<MeetingArtifactCapabilities> {
    const capability=implemented(this.reader.authorized(ref,'minutes'));
    return {transcriptRead:capability, officialSummaryRead:capability, readinessEvents:unsupported,speakerIdentity:'unknown',timestamps:'unknown'};
  }
  async resolveMeeting(ref: ChannelResourceRef): Promise<{source:ChannelResourceRef;meeting?:ChannelResourceRef}> {
    this.reader.require(ref,'minutes');
    if(ref.kind!=='minutes')throw new ChannelError('unsupported','dws_minutes_source_required');
    const data=unwrap(await this.reader.call(['minutes','+detail','--id',ref.externalId,'--artifacts','basic']));
    if (data.taskUuid !== ref.externalId || data.complete !== true) return badShape();
    const basic=object(object(data.basic).result);
    // Source existence verified, but a minute UUID is never invented as a conference ID.
    if ((basic.taskUuid ?? basic.taskUUID ?? basic.task_uuid ?? basic.uuid) !== ref.externalId) return badShape();
    return {source:{...ref,kind:'minutes'}};
  }
  async listArtifacts(ref:ChannelResourceRef):Promise<readonly MeetingArtifact[]> {
    this.reader.require(ref,'minutes');
    if(ref.kind!=='minutes')throw new ChannelError('unsupported','dws_minutes_source_required');
    const results=await Promise.allSettled([
      this.readSummary({...ref,kind:'summary'}), this.readTranscript({...ref,kind:'transcript'},{}),
    ]);
    return results.map((result,index):MeetingArtifact=>{
      const kind=index===0?'summary' as const:'transcript' as const;
      const artifactRef={...ref,kind};
      if(result.status==='rejected')return {ref:artifactRef,sourceRef:{...ref,kind:'minutes'},kind,origin:kind==='summary'?'provider_summary':'provider_transcript',state:result.reason instanceof ChannelError && result.reason.code==='not_ready'?'processing':'unknown',...(result.reason instanceof ChannelError && result.reason.code==='not_ready'?{}:{readError:result.reason instanceof ChannelError?result.reason.code:'temporarily_unavailable' as const})};
      if(kind==='summary')return (result.value as MeetingSummary).artifact;
      return {ref:artifactRef,sourceRef:{...ref,kind:'minutes'},kind,origin:'provider_transcript',state:'ready',reason:'source_readable_not_full_recording_coverage'};
    });
  }

  async getArtifact(ref:ChannelResourceRef):Promise<MeetingArtifact> {
    this.reader.require(ref,'minutes');
    if(ref.kind==='summary')return (await this.readSummary(ref)).artifact;
    if(ref.kind!=='transcript')throw new ChannelError('invalid_request','artifact_kind_required');
    await this.readTranscript(ref,{});
    return {ref,sourceRef:{...ref,kind:'minutes'},kind:'transcript',origin:'provider_transcript',state:'ready',reason:'source_readable_not_full_recording_coverage'};
  }
  async readSummary(ref:ChannelResourceRef):Promise<MeetingSummary> {
    this.reader.require(ref,'minutes');
    if(ref.kind!=='summary')throw new ChannelError('invalid_request','summary_ref_required');
    const data=unwrap(await this.reader.call(['minutes','+detail','--id',ref.externalId,'--artifacts','summary']));
    if(data.taskUuid!==ref.externalId || data.complete!==true)throw new ChannelError('partial_failure','dws_summary_incomplete');
    const raw=object(data.summary); if(raw.success===false || raw.errorCode && raw.errorCode!==0)throw new ChannelError('temporarily_unavailable','dws_summary_failed');
    const result=object(raw.result);
    if(typeof result.fullSummary==='string'&&!result.fullSummary.trim())throw new ChannelError('not_ready','dws_summary_empty');
    const text=string(result.fullSummary);
    return {artifact:{ref,sourceRef:{...ref,kind:'minutes'},kind:'summary',state:'ready',origin:'provider_summary',version:version(text)},text,format:'markdown'};
  }
  async readTranscript(ref:ChannelResourceRef,query:ChannelQuery):Promise<ChannelPage<TranscriptSegment>> {
    this.reader.require(ref,'minutes');
    if(ref.kind!=='transcript')throw new ChannelError('invalid_request','transcript_ref_required');
    if(query.startAt!==undefined || query.endAt!==undefined || query.threadId || query.limit!==undefined || query.order!==undefined)throw new ChannelError('unsupported','dws_transcript_uses_provider_page_size');
    const args=['minutes','+transcript','--id',ref.externalId,'--single-page'];
    const scope=channelCursorScope(this.connection,ref,{});
    const current=query.cursor?this.cursors.decode(scope,query.cursor):undefined;
    const offset=current?.offset??0;
    if(current)args.push('--cursor',id(current.token));
    const envelope=await this.reader.call(args),data=unwrap(envelope);
    if(data.taskUuid!==ref.externalId || typeof data.complete!=='boolean')return badShape();
    const pagination=object(object(envelope.meta).pagination);
    if(typeof pagination.endpoint_exhausted!=='boolean')return badShape();
    const token=optionalString(pagination.next_token);
    if(!pagination.endpoint_exhausted&&!token)return badShape();
    if(token && token===current?.token)throw new ChannelError('partial_failure','dws_repeated_provider_cursor');
    const items=array(data.paragraphList).map((raw,index):TranscriptSegment=>{
      const p=object(raw),text=string(p.paragraph);
      const displayName=optionalString(p.nickName),externalId=optionalString(p.unionId);
      const startMs=optionalMillis(p.startTime),endMs=optionalMillis(p.endTime);
      const speaker:ChannelActor|undefined=displayName||externalId?{kind:'unknown',identityEvidence:'source_label',...(displayName?{displayName}:{}),...(externalId?{externalId,idNamespace:'union_id' as const}:{})}:undefined;
      return {id:optionalString(p.paragraphId)??version(p),sequence:offset+index,text,artifactRef:ref,...(speaker?{speaker}:{}),...(startMs!==undefined?{startMs}:{}),...(endMs!==undefined?{endMs}:{})};
    });
    const nextCursor=token?this.cursors.encode(scope,{offset:offset+items.length,token}):undefined;
    return {items,exhausted:pagination.endpoint_exhausted && data.complete,coverage:data.complete?'authorized_query':'partial',fetchedAt:this.reader.now(),...(nextCursor?{nextCursor}:{}),warnings:['recording_coverage_and_speaker_identity_not_verified']};
  }
}
