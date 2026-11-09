import {DirectoryError} from '@dentity/application';
import type {DirectoryAccessRule,DirectoryMemberSearch} from '@dentity/application';
import type {Store} from '../store.js';
import type {HumanTarget} from '../human-confirmation.js';
import type {EmployeeChannelRecord} from './types.js';

export function usesWeComBotSearch(r:EmployeeChannelRecord):boolean {
  return r.provider==='wecom'&&r.identity.tenantIdNamespace==='app_id';
}
export function weComVerifiedUserIds(r:EmployeeChannelRecord):string[] {
  if(!usesWeComBotSearch(r)||r.wecomContactIdentityRevision!==r.authRevision)return [];
  return [...new Set([...(r.wecomVerifiedContactIds??[]),...(r.wecomContactMappings??[]).map(m=>m.userId)])];
}
export function weComCallbackUserId(r:EmployeeChannelRecord,userId:string):string|undefined {
  if(!usesWeComBotSearch(r)||r.wecomContactIdentityRevision!==r.authRevision)return;
  const ids=[...new Set([...(r.wecomVerifiedContactIds?.includes(userId)?[userId]:[]),...(r.wecomContactMappings??[]).filter(m=>m.userId===userId).map(m=>m.callbackUserId)])];
  return ids.length===1?ids[0]:undefined;
}
export function weComSearchUserId(r:EmployeeChannelRecord,callbackUserId:string):string|undefined {
  if(!usesWeComBotSearch(r)||r.wecomContactIdentityRevision!==r.authRevision)return;
  const ids=[...new Set([...(r.wecomVerifiedContactIds?.includes(callbackUserId)?[callbackUserId]:[]),...(r.wecomContactMappings??[]).filter(m=>m.callbackUserId===callbackUserId).map(m=>m.userId)])];
  return ids.length===1?ids[0]:undefined;
}
export function weComSearchIdentityVerified(r:EmployeeChannelRecord,userId?:string):boolean {
  return userId===undefined?weComVerifiedUserIds(r).length>0:weComCallbackUserId(r,userId)!==undefined;
}
interface Contact {
  user_id:string;
  display_name:string;
  department_paths:string;
  found_at:number;
}
const selectionLifetime=10*60_000;

/** Current referenced member profiles plus a bounded, short-lived search cache.
 * Retaining a profile neither proves an identity nor grants channel access. */
export class WeComBotContacts {
  constructor(private readonly store:Store,private readonly now:()=>number) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS wecom_bot_contacts (
      connection_id TEXT NOT NULL, source_id TEXT NOT NULL, auth_revision INTEGER NOT NULL,
      user_id TEXT NOT NULL, display_name TEXT NOT NULL, department_paths TEXT NOT NULL,
      found_at INTEGER NOT NULL, PRIMARY KEY(connection_id,source_id,auth_revision,user_id)
    )`);
  }
  private current(r:EmployeeChannelRecord):EmployeeChannelRecord|undefined {
    if(!usesWeComBotSearch(r))return;
    const row=this.store.one<{record_json:string}>(`SELECT record_json FROM employee_channel_connections
      WHERE id=? AND workspace_id=? AND entity_id=? AND provider=? AND app_id=?`,r.id,r.workspaceId,r.entityId,r.provider,r.appId);
    const current=row?JSON.parse(row.record_json) as EmployeeChannelRecord:undefined;
    return current&&usesWeComBotSearch(current)&&current.sourceId===r.sourceId&&current.authRevision===r.authRevision&&
      current.botId===r.botId&&current.identity.tenantId===r.identity.tenantId&&current.eventTenantId===r.eventTenantId?current:undefined;
  }
  /** Derive retention from current configuration, never from historical searches.
   * Removed references return to the 500-entry cache on the next search. */
  private retainedIds(r:EmployeeChannelRecord):string[] {
    const ids=new Set(weComVerifiedUserIds(r).filter(id=>{
      const callback=weComCallbackUserId(r,id);return callback!==undefined&&weComSearchUserId(r,callback)===id;
    }));
    for(const challenge of r.wecomMemberChallenges??[])if(challenge.authRevision===r.authRevision&&challenge.status==='pending'&&challenge.expiresAt>this.now())ids.add(challenge.userId);
    const addRules=(rules:readonly DirectoryAccessRule[])=>{for(const rule of rules){
      if(rule.sourceId!==r.sourceId||rule.kind!=='channel_user')continue;
      let subject:unknown;try{subject=JSON.parse(rule.subjectId);}catch{continue;}
      if(Array.isArray(subject)&&subject.length===4&&subject[0]==='channel_user'&&subject[1]==='user_id'&&subject[2]===r.appId&&typeof subject[3]==='string')ids.add(subject[3]);
    }};
    type Access={allow?:DirectoryAccessRule[];deny?:DirectoryAccessRule[];channelPolicies?:{sourceId:string;allow:DirectoryAccessRule[];deny:DirectoryAccessRule[]}[]};
    const addAccess=(access:Access)=>{
      addRules(access.allow??[]);addRules(access.deny??[]);
      for(const policy of access.channelPolicies??[])if(policy.sourceId===r.sourceId){addRules(policy.allow);addRules(policy.deny);}
    };
    if(this.store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_directory_policies'")){
      const policy=this.store.one<{allow_json:string;deny_json:string;channel_policies_json:string}>('SELECT allow_json,deny_json,channel_policies_json FROM entity_directory_policies WHERE workspace_id=? AND entity_id=?',r.workspaceId,r.entityId);
      if(policy)addAccess({allow:JSON.parse(policy.allow_json),deny:JSON.parse(policy.deny_json),channelPolicies:JSON.parse(policy.channel_policies_json)});
    }
    if(this.store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capability_packages'"))for(const row of this.store.all<{config_json:string}>('SELECT config_json FROM capability_packages WHERE workspace_id=? AND entity_id=?',r.workspaceId,r.entityId)){
      const config=JSON.parse(row.config_json) as {directoryAccess?:Access};if(config.directoryAccess)addAccess(config.directoryAccess);
    }
    const saved=this.store.one<{rules_json:string}>('SELECT rules_json FROM employee_human_rules WHERE workspace_id=? AND entity_id=?',r.workspaceId,r.entityId);
    for(const {target} of JSON.parse(saved?.rules_json??'[]') as {target:HumanTarget}[]){
      if(target.kind==='web'||target.connectionId!==r.id||target.provider!=='wecom'||target.appId!==r.appId||target.tenantId!==r.eventTenantId||target.identityNamespace!=='user_id')continue;
      const reference=target.kind==='wecom_directory'?target:target.directoryReference;
      if(reference){if(reference.sourceId===r.sourceId&&reference.authRevision===r.authRevision)ids.add(reference.directoryUserId);}
      else if(target.kind==='channel'){const id=weComSearchUserId(r,target.userId);if(id&&weComCallbackUserId(r,id)===target.userId)ids.add(id);}
    }
    return [...ids];
  }
  get(r:EmployeeChannelRecord,userId:string):Contact|undefined {
    if(!this.current(r))return;
    return this.store.one<Contact>(`SELECT user_id,display_name,department_paths,found_at FROM wecom_bot_contacts
      WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id=?`,r.id,r.sourceId,r.authRevision,userId);
  }
  recent(r:EmployeeChannelRecord):Contact[] {
    if(!this.current(r))return [];
    return this.store.all<Contact>(`SELECT user_id,display_name,department_paths,found_at FROM wecom_bot_contacts
      WHERE connection_id=? AND source_id=? AND auth_revision=? AND found_at>=? ORDER BY found_at DESC,user_id LIMIT 500`,
      r.id,r.sourceId,r.authRevision,this.now()-selectionLifetime);
  }
  /** Existing verified/configured people remain visible without refreshing the
   * selection timestamp. Ordinary new candidates still expire after ten minutes. */
  retained(r:EmployeeChannelRecord):Contact[] {
    const current=this.current(r);if(!current)return [];
    return this.store.all<Contact>(`SELECT user_id,display_name,department_paths,found_at FROM wecom_bot_contacts
      WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id IN (SELECT value FROM json_each(?)) ORDER BY found_at DESC,user_id`,
      r.id,r.sourceId,r.authRevision,JSON.stringify(this.retainedIds(current)));
  }
  selectable(r:EmployeeChannelRecord,userId:string):boolean {
    const contact=this.get(r,userId);
    return !!contact&&contact.found_at>=this.now()-selectionLifetime;
  }
  remember(r:EmployeeChannelRecord,members:Awaited<ReturnType<DirectoryMemberSearch['search']>>['members']){
    this.store.transaction(()=>{
      const current=this.current(r);if(!current)return;
      this.store.run('DELETE FROM wecom_bot_contacts WHERE connection_id=? AND (source_id<>? OR auth_revision<>?)',r.id,r.sourceId,r.authRevision);
      for(const member of members)this.store.run(`INSERT INTO wecom_bot_contacts VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(connection_id,source_id,auth_revision,user_id) DO UPDATE SET display_name=excluded.display_name,
        department_paths=excluded.department_paths,found_at=excluded.found_at`,r.id,r.sourceId,r.authRevision,
        member.id,member.displayName,JSON.stringify(member.departmentPaths),this.now());
      this.store.run(`DELETE FROM wecom_bot_contacts WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id IN
        (SELECT user_id FROM wecom_bot_contacts WHERE connection_id=? AND source_id=? AND auth_revision=?
         AND user_id NOT IN (SELECT value FROM json_each(?)) ORDER BY found_at DESC,user_id LIMIT -1 OFFSET 500)`,
        r.id,r.sourceId,r.authRevision,r.id,r.sourceId,r.authRevision,JSON.stringify(this.retainedIds(current)));
    });
  }
  async verifyRecipient(r:EmployeeChannelRecord,userId:string,adapter:DirectoryMemberSearch){
    const current=this.current(r),searchId=current?weComSearchUserId(current,userId):undefined,candidate=searchId?this.get(r,searchId):undefined;
    if(!searchId||!candidate||weComCallbackUserId(current!,searchId)!==userId)throw new DirectoryError('authorization_denied');
    const result=await adapter.search([candidate.display_name]);
    const latest=this.current(r);
    if(!latest||weComSearchUserId(latest,userId)!==searchId||weComCallbackUserId(latest,searchId)!==userId||!result.members.some(member=>member.id===searchId))throw new DirectoryError('authorization_denied');
  }
  remove(connectionId:string){
    this.store.run('DELETE FROM wecom_bot_contacts WHERE connection_id=?',connectionId);
  }
}
