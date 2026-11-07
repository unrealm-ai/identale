import {createHash} from 'node:crypto';
import type {ChannelMessageEvent,MessageLoopBinding,GroupContextPort} from '@dentity/application';
import type {Store} from '../store.js';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const GROUP_CONTEXT_LIMIT=100;
/** Platform persistence only: one bounded window, no adapter SQL or history backfill. */
export class SqliteGroupContext implements GroupContextPort {
 private messageCursor=0;private rootCursor=0;private stopped=false;private cleanupStarted=false;
 private timer:ReturnType<typeof setTimeout>|undefined;private immediate:ReturnType<typeof setImmediate>|undefined;
 constructor(private readonly store:Store,private readonly shareRootAssets?:(binding:MessageLoopBinding,event:ChannelMessageEvent,ids:readonly string[])=>void){store.db.exec(`
 CREATE TABLE IF NOT EXISTS group_live_membership(connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,present INTEGER NOT NULL,changed_at INTEGER NOT NULL,PRIMARY KEY(connection_id,chat_id));
 CREATE TABLE IF NOT EXISTS group_live_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,family TEXT NOT NULL,connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,occurred_at INTEGER NOT NULL,raw_json TEXT NOT NULL,formatted TEXT NOT NULL,mentioned INTEGER NOT NULL,batch_id TEXT,status TEXT NOT NULL DEFAULT 'pending',UNIQUE(scope,message_id));
 CREATE INDEX IF NOT EXISTS group_live_window ON group_live_messages(scope,occurred_at,sequence);
 CREATE TABLE IF NOT EXISTS group_live_topic_roots(scope TEXT PRIMARY KEY,family TEXT NOT NULL,connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,root_batch_id TEXT,committed INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS group_live_family ON group_live_messages(family,scope);
 CREATE INDEX IF NOT EXISTS group_live_batch_ref ON group_live_messages(batch_id);
 CREATE INDEX IF NOT EXISTS group_live_connection_chat ON group_live_messages(connection_id,chat_id,sequence);
 CREATE INDEX IF NOT EXISTS group_live_connection_sequence ON group_live_messages(connection_id,sequence);
 CREATE INDEX IF NOT EXISTS group_root_connection_chat ON group_live_topic_roots(connection_id,chat_id);
 CREATE INDEX IF NOT EXISTS group_root_connection ON group_live_topic_roots(connection_id);
 CREATE INDEX IF NOT EXISTS group_root_family ON group_live_topic_roots(family,scope);
 CREATE TABLE IF NOT EXISTS group_cleanup_targets(connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_cutoff INTEGER NOT NULL,root_cutoff INTEGER NOT NULL,PRIMARY KEY(connection_id,chat_id));
 CREATE TABLE IF NOT EXISTS group_live_batches(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'accepted',released INTEGER NOT NULL DEFAULT 0,guard_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS group_batch_status_released ON group_live_batches(status,released,id);
 CREATE INDEX IF NOT EXISTS group_batch_scope_released ON group_live_batches(scope,released,id);`);
 if(!store.all<{name:string}>('PRAGMA table_info(group_live_topic_roots)').some(c=>c.name==='guard_json'))store.db.exec("ALTER TABLE group_live_topic_roots ADD COLUMN guard_json TEXT");
 if(store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_inbox'"))store.db.exec('CREATE INDEX IF NOT EXISTS channel_inbox_history_batch ON channel_inbox(history_batch_id)');
 }
 private scope(b:MessageLoopBinding,e:ChannelMessageEvent){const m=this.store.one<{present:number;version:number;changed_at:number}>('SELECT present,version,changed_at FROM group_live_membership WHERE connection_id=? AND chat_id=?',b.connectionId,e.message.conversation.externalId);if(m?.present===0||m&&e.message.occurredAt<m.changed_at)return;
 return digest([b.workspaceId,b.entityId,b.connectionId,b.appId,b.bindingVersion,b.context?.listenGeneration??0,e.tenantId,e.message.conversation.externalId,e.message.threadId??'',m?.version??0]);}
 canSend(connectionId:string,chatId:string){return this.store.one<{present:number}>('SELECT present FROM group_live_membership WHERE connection_id=? AND chat_id=?',connectionId,chatId)?.present!==0;}
 allowed(b:MessageLoopBinding,e:ChannelMessageEvent){return this.scope(b,e)!==undefined;}
 membership(connectionId:string,chatId:string,present:boolean,at:number,verifiedCurrent=false){this.store.transaction(()=>{const old=this.store.one<{changed_at:number;present:number}>('SELECT changed_at,present FROM group_live_membership WHERE connection_id=? AND chat_id=?',connectionId,chatId);if(old&&!verifiedCurrent&&(old.changed_at>=at||old.present===Number(present)))return;at=Math.max(at,old?.changed_at??0);if(old&&old.present===Number(present)){if(!present)this.store.run('UPDATE group_live_membership SET changed_at=? WHERE connection_id=? AND chat_id=?',at,connectionId,chatId);return;}this.queueCleanup(connectionId,chatId);this.store.run('INSERT INTO group_live_membership(connection_id,chat_id,present,changed_at) VALUES(?,?,?,?) ON CONFLICT(connection_id,chat_id) DO UPDATE SET present=excluded.present,changed_at=excluded.changed_at,version=version+1',connectionId,chatId,Number(present),at);});}
 collect(b:MessageLoopBinding,e:ChannelMessageEvent,formatted:string){const family=digest([b.workspaceId,b.entityId,b.connectionId,e.message.conversation.externalId,e.message.threadId??'']);const scope=this.scope(b,e);if(!scope)return 'ignored' as const;return this.store.transaction(()=>{const r=this.store.run('INSERT OR IGNORE INTO group_live_messages(scope,family,connection_id,chat_id,message_id,occurred_at,raw_json,formatted,mentioned) VALUES(?,?,?,?,?,?,?,?,?)',scope,family,b.connectionId,e.message.conversation.externalId,e.message.id,e.message.occurredAt,JSON.stringify(e),formatted,Number(e.message.mentions.includes(b.policy.entityMentionId)));
 this.store.run('DELETE FROM group_live_messages WHERE scope=? AND sequence NOT IN(SELECT sequence FROM group_live_messages WHERE scope=? ORDER BY occurred_at DESC,sequence DESC LIMIT ?)',scope,scope,GROUP_CONTEXT_LIMIT);
 return r.changes?'created' as const:'duplicate' as const;});}
 /** Events register bounded indexed work; physical cleanup never gates admission/commit. */
 queueCleanup(connectionId:string,chatId=''){if(this.stopped)return;const m=this.store.one<{n:number}>('SELECT sequence n FROM group_live_messages WHERE connection_id=?'+(chatId?' AND chat_id=?':'')+' ORDER BY sequence DESC LIMIT 1',...chatId?[connectionId,chatId]:[connectionId])?.n??0;
 const r=this.store.one<{n:number}>('SELECT rowid n FROM group_live_topic_roots WHERE connection_id=?'+(chatId?' AND chat_id=?':'')+' ORDER BY rowid DESC LIMIT 1',...chatId?[connectionId,chatId]:[connectionId])?.n??0;
 this.store.run('INSERT INTO group_cleanup_targets VALUES(?,?,?,?) ON CONFLICT(connection_id,chat_id) DO UPDATE SET message_cutoff=MAX(message_cutoff,excluded.message_cutoff),root_cutoff=MAX(root_cutoff,excluded.root_cutoff)',connectionId,chatId,m,r);}
 private protected(batchId:string|null){if(!batchId)return false;const batch=this.store.one<{released:number}>('SELECT released FROM group_live_batches WHERE id=?',batchId);if(batch?.released===0)return true;
 return !!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_inbox'")&&!!this.store.one('SELECT id FROM channel_inbox WHERE history_batch_id=? LIMIT 1',batchId);}
 async cleanupStep(resolve:(id:string)=>Promise<MessageLoopBinding|undefined>,limit=100){if(this.stopped)return{visited:0,deleted:0,more:false};if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('invalid_group_cleanup_limit');
 const target=this.store.one<{connection_id:string;chat_id:string;message_cutoff:number;root_cutoff:number}>('SELECT * FROM group_cleanup_targets ORDER BY connection_id,chat_id LIMIT 1');
 const filter=target?'connection_id=?'+(target.chat_id?' AND chat_id=?':'')+' AND sequence<=?':'sequence>?';const params=target?[target.connection_id,...target.chat_id?[target.chat_id]:[],target.message_cutoff]:[this.messageCursor];
 const rows=this.store.all<{sequence:number;scope:string;connection_id:string;raw_json:string;batch_id:string|null}>('SELECT sequence,scope,connection_id,raw_json,batch_id FROM group_live_messages WHERE '+filter+' ORDER BY sequence LIMIT ?',...params,limit);
 let deleted=0;const bindings=new Map<string,MessageLoopBinding|undefined>();
 for(const row of rows){if(this.stopped)break;if(!target)this.messageCursor=row.sequence;
 if(!bindings.has(row.connection_id))bindings.set(row.connection_id,await resolve(row.connection_id));if(this.stopped)break;const b=bindings.get(row.connection_id);
 const stale=!b?.context?.groupListenEnabled||this.scope(b,JSON.parse(row.raw_json) as ChannelMessageEvent)!==row.scope;
 if(stale&&!this.protected(row.batch_id))deleted+=Number(this.store.run('DELETE FROM group_live_messages WHERE sequence=?',row.sequence).changes);}
 if(this.stopped)return{visited:rows.length,deleted,more:false};
 const rootFilter=target?'connection_id=?'+(target.chat_id?' AND chat_id=?':'')+' AND rowid<=?':'rowid>?';const rootParams=target?[target.connection_id,...target.chat_id?[target.chat_id]:[],target.root_cutoff]:[this.rootCursor];
 const roots=this.store.all<{rowId:number;scope:string;connection_id:string;chat_id:string;root_batch_id:string|null;guard_json:string|null}>('SELECT rowid rowId,scope,connection_id,chat_id,root_batch_id,guard_json FROM group_live_topic_roots WHERE '+rootFilter+' ORDER BY rowid LIMIT ?',...rootParams,limit);
 for(const row of roots){if(this.stopped)break;if(!target)this.rootCursor=row.rowId;if(!bindings.has(row.connection_id))bindings.set(row.connection_id,await resolve(row.connection_id));if(this.stopped)break;const b=bindings.get(row.connection_id),g=row.guard_json?JSON.parse(row.guard_json):undefined,m=this.store.one<{version:number;present:number}>('SELECT version,present FROM group_live_membership WHERE connection_id=? AND chat_id=?',row.connection_id,row.chat_id);
 // Legacy markers lack a reconstructible thread guard. Retire only after all window
 // and batch facts for that scope have gone through their existing safe retention.
 const legacyOrphan=!g&&!this.store.one('SELECT sequence FROM group_live_messages WHERE scope=? LIMIT 1',row.scope)&&!this.store.one('SELECT id FROM group_live_batches WHERE scope=? LIMIT 1',row.scope);
 const stale=legacyOrphan||!b?.context?.groupListenEnabled||g&&(g.bindingVersion!==b.bindingVersion||g.listenGeneration!==(b.context.listenGeneration??0)||g.membershipVersion!==(m?.version??0)||m?.present===0);
 if(stale&&!this.protected(row.root_batch_id))deleted+=Number(this.store.run('DELETE FROM group_live_topic_roots WHERE rowid=?',row.rowId).changes);}
 if(this.stopped)return{visited:rows.length+roots.length,deleted,more:false};
 // Protected rows must not starve every later cleanup target. Their guards still fence reads;
 // the global cursor revisits them after the durable handoff has released references.
 if(target)this.store.run('DELETE FROM group_cleanup_targets WHERE connection_id=? AND chat_id=?',target.connection_id,target.chat_id);
 if(!target&&rows.length<limit)this.messageCursor=0;if(!target&&roots.length<limit)this.rootCursor=0;
 return{visited:rows.length+roots.length,deleted,more:!!target||rows.length===limit||roots.length===limit};
 }
 startCleanup(resolve:(id:string)=>Promise<MessageLoopBinding|undefined>){if(this.cleanupStarted||this.stopped)return;this.cleanupStarted=true;const cycle=()=>{let budget=8;const step=async()=>{if(this.stopped)return;try{const result=await this.cleanupStep(resolve);if(this.stopped)return;if(result.more&&--budget>0){this.immediate=setImmediate(()=>{this.immediate=undefined;void step();});this.immediate.unref();return;}}catch{/* Retry on next maintenance interval; safety guards remain authoritative. */}if(!this.stopped){this.timer=setTimeout(()=>{this.timer=undefined;cycle();},60000);this.timer.unref();}};void step();};this.timer=setTimeout(()=>{this.timer=undefined;cycle();},0);this.timer.unref();}
 close(){this.stopped=true;if(this.timer)clearTimeout(this.timer);if(this.immediate)clearImmediate(this.immediate);this.timer=undefined;this.immediate=undefined;}
 reserve(b:MessageLoopBinding,e:ChannelMessageEvent,batchId:string,current:string){const scope=this.scope(b,e);if(!scope)throw Error('group_membership_changed');return this.store.transaction(()=>{
 if(this.store.one('SELECT id FROM group_live_batches WHERE id=?',batchId))return undefined;
 const boundary=this.store.one<{sequence:number}>('SELECT sequence FROM group_live_messages WHERE scope=? AND message_id=?',scope,e.message.id)?.sequence??Number.MAX_SAFE_INTEGER;
 let rows=this.store.all<{sequence:number;formatted:string;message_id:string;raw_json:string}>("SELECT sequence,formatted,message_id,raw_json FROM group_live_messages WHERE scope=? AND status='pending' AND batch_id IS NULL AND (occurred_at<? OR (occurred_at=? AND sequence<=?)) AND (mentioned=0 OR message_id=?) ORDER BY occurred_at,sequence",scope,e.message.occurredAt,e.message.occurredAt,boundary,e.message.id);
 this.store.run('INSERT INTO group_live_batches(id,scope,guard_json) VALUES(?,?,?)',batchId,scope,JSON.stringify({connectionId:b.connectionId,chatId:e.message.conversation.externalId,threadId:e.message.threadId??'',bindingVersion:b.bindingVersion,listenGeneration:b.context?.listenGeneration??0,membershipVersion:this.store.one<{version:number}>('SELECT version FROM group_live_membership WHERE connection_id=? AND chat_id=?',b.connectionId,e.message.conversation.externalId)?.version??0}));
 // A single per-target marker survives window eviction; it retains no old source body/ID.
 let background:string|undefined;const assetIds=new Set((e.message.sharedAssets??[]).map(a=>a.assetId));const rootId=e.message.rootMessageId;
 if(e.message.threadId&&rootId&&!this.store.one('SELECT scope FROM group_live_topic_roots WHERE scope=?',scope)){
  const inTopic=this.store.one<{status:string}>('SELECT status FROM group_live_messages WHERE scope=? AND message_id=?',scope,rootId);
  const alreadyHere=rootId===e.message.id||rows.some(r=>r.message_id===rootId);
  const {threadId:_thread,...mainMessage}=e.message;const mainScope=this.scope(b,{...e,message:mainMessage});
  const root=!inTopic&&!alreadyHere&&mainScope?this.store.one<{formatted:string;raw_json:string}>('SELECT formatted,raw_json FROM group_live_messages WHERE scope=? AND message_id=?',mainScope,rootId):undefined;
  if(root||alreadyHere||inTopic?.status==='committed'){
   this.store.run('INSERT INTO group_live_topic_roots(scope,family,connection_id,chat_id,root_batch_id,committed,guard_json) VALUES(?,?,?,?,?,?,?)',scope,digest([b.workspaceId,b.entityId,b.connectionId,e.message.conversation.externalId,e.message.threadId]),b.connectionId,e.message.conversation.externalId,inTopic?.status==='committed'?null:batchId,Number(inTopic?.status==='committed'),JSON.stringify({bindingVersion:b.bindingVersion,listenGeneration:b.context?.listenGeneration??0,membershipVersion:this.store.one<{version:number}>('SELECT version FROM group_live_membership WHERE connection_id=? AND chat_id=?',b.connectionId,e.message.conversation.externalId)?.version??0}));
   if(root){for(const a of (JSON.parse(root.raw_json) as ChannelMessageEvent).message.sharedAssets??[])assetIds.add(a.assetId);}if(root)background=`[话题起始背景 来源=本地群消息 消息ID=${JSON.stringify(rootId)}]\n${root.formatted}`;
  }
 }
 // Current @ always occupies one slot. The optional root uses the same 100-input budget.
 const ownRoot=!background&&rootId!==e.message.id?rows.find(r=>r.message_id===rootId):undefined;
 rows=rows.filter(r=>r.message_id!==e.message.id&&r!==ownRoot).slice(-(GROUP_CONTEXT_LIMIT-1-(background||ownRoot?1:0)));if(ownRoot)rows.unshift(ownRoot);
 for(const row of rows)for(const a of (JSON.parse(row.raw_json) as ChannelMessageEvent).message.sharedAssets??[])assetIds.add(a.assetId);
 this.shareRootAssets?.(b,e,[...assetIds]);
 const guard=this.store.one<{guard_json:string}>('SELECT guard_json FROM group_live_batches WHERE id=?',batchId)!;this.store.run('UPDATE group_live_batches SET guard_json=? WHERE id=?',JSON.stringify({...JSON.parse(guard.guard_json),assetIds:[...assetIds]}),batchId);
 for(const row of rows)this.store.run('UPDATE group_live_messages SET batch_id=? WHERE sequence=?',batchId,row.sequence);
 this.store.run('UPDATE group_live_messages SET batch_id=? WHERE scope=? AND message_id=?',batchId,scope,e.message.id);
 const texts=rows.map(r=>r.formatted);if(background)texts.unshift(background);texts.push(current);return texts.join('\n');
 });}
 assetIds(batchId:string):readonly string[]{const row=this.store.one<{guard_json:string}>('SELECT guard_json FROM group_live_batches WHERE id=?',batchId);return row?JSON.parse(row.guard_json).assetIds??[]:[];}
 recovery(b:MessageLoopBinding,e:ChannelMessageEvent,batchId:string){const scope=this.scope(b,e);if(!scope)return;return this.store.one<{batchId:string;scopeJson:string;conversationId:string;turnId:string}>("SELECT g.id batchId,t.scope_json scopeJson,t.conversation_id conversationId,t.id turnId FROM group_live_batches g JOIN interaction_turns t ON t.operation_id=('channel:'||g.id) WHERE g.scope=? AND g.released=0 AND g.id!=? LIMIT 1",scope,batchId);}
 busy(b:MessageLoopBinding,e:ChannelMessageEvent,batchId:string){const scope=this.scope(b,e);return !!scope&&!!this.store.one('SELECT id FROM group_live_batches WHERE scope=? AND released=0 AND id!=?',scope,batchId);}
 finish(batchId:string){this.store.run('UPDATE group_live_batches SET released=1 WHERE id=?',batchId);}
 commitAllowed(batchId:string,b:Pick<MessageLoopBinding,'connectionId'|'bindingVersion'|'context'>){const row=this.store.one<{guard_json:string}>('SELECT guard_json FROM group_live_batches WHERE id=?',batchId);if(!row||!b.context?.groupListenEnabled)return false;const g=JSON.parse(row.guard_json);const member=this.store.one<{version:number;present:number}>('SELECT version,present FROM group_live_membership WHERE connection_id=? AND chat_id=?',b.connectionId,g.chatId);return g.connectionId===b.connectionId&&g.bindingVersion===b.bindingVersion&&g.listenGeneration===(b.context.listenGeneration??0)&&g.membershipVersion===(member?.version??0)&&member?.present!==0;}
 receipt(batchId:string,status:'committed'|'accepted'|'unknown'){this.store.transaction(()=>{this.store.run('UPDATE group_live_batches SET status=? WHERE id=?',status,batchId);if(status==='committed'){this.store.run("UPDATE group_live_messages SET status='committed' WHERE batch_id=?",batchId);this.store.run('UPDATE group_live_topic_roots SET committed=1 WHERE root_batch_id=?',batchId);}});}
}
