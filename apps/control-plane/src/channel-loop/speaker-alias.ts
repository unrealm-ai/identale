import {createHash} from 'node:crypto';
import {conversationOwnerKey,type TaskScope} from '@dentity/application';
import type {Store} from '../store.js';

/** Both queue adapters share numbering; allocating an alias never creates a Conversation or RT. */
export function speakerAlias(store:Store,conversation:string|TaskScope,actorKey:string):string {
 return store.transaction(()=>{
  let key:string;
  if(typeof conversation==='string')key=conversation;
  else {
   const owner=conversationOwnerKey(conversation);
   key='channel:'+createHash('sha256').update(JSON.stringify([conversation.workspaceId,conversation.entityId,owner])).digest('hex');
   // Adopt the complete old UUID-keyed map before allocating any new numbers.
   if(!store.one('SELECT 1 FROM channel_speaker_aliases WHERE conversation_id=? LIMIT 1',key)){
    const old=store.one<{id:string}>('SELECT id FROM conversations WHERE workspace_id=? AND entity_id=? AND owner_key=? AND operation_id=?',conversation.workspaceId,conversation.entityId,owner,key);
    if(old)store.run('INSERT INTO channel_speaker_aliases(conversation_id,actor_key,ordinal) SELECT ?,actor_key,ordinal FROM channel_speaker_aliases WHERE conversation_id=?',key,old.id);
   }
  }
  const previous=store.one<{ordinal:number}>('SELECT ordinal FROM channel_speaker_aliases WHERE conversation_id=? AND actor_key=?',key,actorKey);
  if(previous)return `成员${previous.ordinal}`;
  const ordinal=store.one<{next:number}>('SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM channel_speaker_aliases WHERE conversation_id=?',key)!.next;
  store.run('INSERT INTO channel_speaker_aliases VALUES(?,?,?)',key,actorKey,ordinal);
  return `成员${ordinal}`;
 });
}
