import {createHash} from 'node:crypto';
import {TaskError,type ChannelMessageEvent,type MessageLoopBinding} from '@dentity/application';
import type {Store} from '../store.js';
import {messagePreview} from '../notifications/targets.js';
export interface DiscoveredGroup {id:string;chatId:string;name:string|null;preview:string;lastMessageId:string;lastMessageAt:number;available:boolean}
export class DiscoveredGroups {
 constructor(private readonly store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS channel_discovered_groups(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,connection_id TEXT NOT NULL,app_id TEXT NOT NULL,tenant_id TEXT NOT NULL,binding_version TEXT NOT NULL,chat_id TEXT NOT NULL,name TEXT,preview TEXT NOT NULL,last_message_id TEXT NOT NULL,last_message_at INTEGER NOT NULL,membership_at INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS channel_group_mentions_seen(id TEXT PRIMARY KEY);
 CREATE INDEX IF NOT EXISTS channel_discovered_groups_page ON channel_discovered_groups(workspace_id,entity_id,connection_id,app_id,tenant_id,binding_version,last_message_at DESC,id DESC);
 CREATE INDEX IF NOT EXISTS channel_discovered_groups_membership ON channel_discovered_groups(connection_id,chat_id);`);}
 record(b:MessageLoopBinding,event:ChannelMessageEvent){
  const m=event.message;if(event.origin!=='live'||m.conversationKind!=='group'||m.author.kind!=='human'||m.author.identityEvidence!=='channel_verified'||b.policy.ownSenderIds.includes(m.author.externalId??'')||!(m.mentions.includes(b.policy.entityMentionId)||b.provider==='wecom'&&m.providerDirectedBot===true||b.provider==='feishu'&&b.context?.groupListenEnabled===true))return;
  if(event.connectionId!==b.connectionId||event.tenantId!==b.connection.tenantId||m.conversation.connectionId!==b.connectionId||m.conversation.tenantId!==event.tenantId)throw new TaskError(403,'group_source_mismatch');
  const id=createHash('sha256').update(JSON.stringify([b.workspaceId,b.entityId,b.connectionId,b.appId,event.tenantId,b.bindingVersion,m.conversation.externalId])).digest('hex');
  this.store.transaction(()=>{
  const receipt=createHash('sha256').update(JSON.stringify([id,m.id])).digest('hex');if(!this.store.run('INSERT OR IGNORE INTO channel_group_mentions_seen VALUES(?)',receipt).changes)return;
  const name=b.provider==='dingtalk'&&m.conversationTitle?Array.from(m.conversationTitle.trim()).slice(0,120).join(''):null;
  const mentionKeys=new Set((m.mentionDetails??[]).filter(x=>x.id===b.policy.entityMentionId&&!(m.mentionDetails??[]).some(y=>y.key===x.key&&y.id!==x.id)).map(x=>x.key));
  const body=m.content?[m.content.title??'',...m.content.blocks.map(block=>block.map(node=>{
   switch(node.type){
    case'text':case'markdown':case'code':return node.text;
    case'link':return node.text;
    case'mention':return node.id===b.policy.entityMentionId?'':`@${node.text}`;
    case'asset':return node.asset.kind==='image'?'[图片]':node.asset.kind==='file'?'[文件]'+(node.asset.name?' '+node.asset.name.split(/[\\/]/).at(-1):''):'[会议资料]';
    case'emotion':return'[表情]';case'separator':return' ';case'unsupported':return'[非文本消息]';
   }
  }).join(' '))].join(' '):m.text;
  const preview=messagePreview(body.replace(/@_user_[A-Za-z0-9_]+/g,key=>mentionKeys.has(key)?' ':key));
  this.store.run(`INSERT INTO channel_discovered_groups(id,workspace_id,entity_id,connection_id,app_id,tenant_id,binding_version,chat_id,name,preview,last_message_id,last_message_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET name=coalesce(excluded.name,channel_discovered_groups.name),preview=excluded.preview,last_message_id=excluded.last_message_id,last_message_at=excluded.last_message_at,available=CASE WHEN excluded.last_message_at>=membership_at THEN 1 ELSE available END
 WHERE excluded.last_message_id!=channel_discovered_groups.last_message_id AND (excluded.last_message_at>channel_discovered_groups.last_message_at OR (excluded.last_message_at=channel_discovered_groups.last_message_at AND excluded.last_message_id>channel_discovered_groups.last_message_id))`,id,b.workspaceId,b.entityId,b.connectionId,b.appId,event.tenantId,b.bindingVersion,m.conversation.externalId,name,preview,m.id,m.occurredAt);
  });
 }
 /** Lifecycle evidence can discover a group without inventing a message or preview. */
 discover(b:MessageLoopBinding,chatId:string,at:number,name?:string){
  const id=createHash('sha256').update(JSON.stringify([b.workspaceId,b.entityId,b.connectionId,b.appId,b.connection.tenantId,b.bindingVersion,chatId])).digest('hex');
  this.store.run(`INSERT INTO channel_discovered_groups(id,workspace_id,entity_id,connection_id,app_id,tenant_id,binding_version,chat_id,name,preview,last_message_id,last_message_at) VALUES(?,?,?,?,?,?,?,?,?,'','',?) ON CONFLICT(id) DO UPDATE SET name=coalesce(excluded.name,channel_discovered_groups.name)`,id,b.workspaceId,b.entityId,b.connectionId,b.appId,b.connection.tenantId,b.bindingVersion,chatId,name??null,at);
 }
 membership(connectionId:string,chatId:string,present:boolean,at:number){this.store.run('UPDATE channel_discovered_groups SET available=?,membership_at=? WHERE connection_id=? AND chat_id=? AND membership_at<=?',present?1:0,at,connectionId,chatId,at);}
 list(b:MessageLoopBinding,query:{cursor?:unknown;q?:unknown}){
  if(query.q!==undefined&&(typeof query.q!=='string'||query.q.length>120))throw new TaskError(400,'invalid_group_query');
  const scope=JSON.stringify([b.workspaceId,b.entityId,b.connectionId,b.appId,b.connection.tenantId,b.bindingVersion,query.q??'']);
  let cursor:{at:number;id:string;scope:string}|undefined;if(query.cursor!==undefined){try{cursor=JSON.parse(Buffer.from(String(query.cursor),'base64url').toString()) as typeof cursor;if(!cursor||cursor.scope!==scope||!Number.isSafeInteger(cursor.at)||!/^\w{64}$/.test(cursor.id))throw Error();}catch{throw new TaskError(400,'invalid_group_cursor');}}
  const rows=this.store.all<DiscoveredGroup>(`SELECT id,chat_id chatId,name,preview,last_message_id lastMessageId,last_message_at lastMessageAt,available FROM channel_discovered_groups WHERE workspace_id=? AND entity_id=? AND connection_id=? AND app_id=? AND tenant_id=? AND binding_version=? AND (?='' OR instr(coalesce(name,'')||preview,?)>0) AND (? IS NULL OR last_message_at<? OR (last_message_at=? AND id<?)) ORDER BY last_message_at DESC,id DESC LIMIT 31`,b.workspaceId,b.entityId,b.connectionId,b.appId,b.connection.tenantId,b.bindingVersion,query.q??'',query.q??'',cursor?.at??null,cursor?.at??null,cursor?.at??null,cursor?.id??null);
  const more=rows.length>30,items=rows.slice(0,30).map(r=>({...r,available:!!r.available})),last=items.at(-1);return{items,nextCursor:more&&last?Buffer.from(JSON.stringify({at:last.lastMessageAt,id:last.id,scope})).toString('base64url'):null,coverage:'mentions_only' as const};
 }
}
