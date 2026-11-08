import {DirectoryError} from '@dentity/application';
import type {DirectoryMemberSearch} from '@dentity/application';
import type {Store} from '../store.js';
import type {EmployeeChannelRecord} from './types.js';

export function usesWeComBotSearch(r:EmployeeChannelRecord):boolean {
  return r.provider==='wecom'&&r.identity.tenantIdNamespace==='app_id';
}
export function weComSearchIdentityVerified(r:EmployeeChannelRecord):boolean {
  return usesWeComBotSearch(r)&&r.wecomContactIdentityRevision===r.authRevision;
}
interface Contact {
  user_id:string;
  display_name:string;
  department_paths:string;
  found_at:number;
}
const selectionLifetime=10*60_000;

/** Bounded admin search evidence, scoped to the source and credential revision. */
export class WeComBotContacts {
  constructor(private readonly store:Store,private readonly now:()=>number) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS wecom_bot_contacts (
      connection_id TEXT NOT NULL, source_id TEXT NOT NULL, auth_revision INTEGER NOT NULL,
      user_id TEXT NOT NULL, display_name TEXT NOT NULL, department_paths TEXT NOT NULL,
      found_at INTEGER NOT NULL, PRIMARY KEY(connection_id,source_id,auth_revision,user_id)
    )`);
  }
  get(r:EmployeeChannelRecord,userId:string):Contact|undefined {
    if(!usesWeComBotSearch(r))return;
    return this.store.one<Contact>(`SELECT user_id,display_name,department_paths,found_at FROM wecom_bot_contacts
      WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id=?`,r.id,r.sourceId,r.authRevision,userId);
  }
  recent(r:EmployeeChannelRecord):Contact[] {
    if(!usesWeComBotSearch(r))return [];
    return this.store.all<Contact>(`SELECT user_id,display_name,department_paths,found_at FROM wecom_bot_contacts
      WHERE connection_id=? AND source_id=? AND auth_revision=? AND found_at>=? ORDER BY found_at DESC,user_id LIMIT 500`,
      r.id,r.sourceId,r.authRevision,this.now()-selectionLifetime);
  }
  selectable(r:EmployeeChannelRecord,userId:string):boolean {
    const contact=this.get(r,userId);
    return !!contact&&contact.found_at>=this.now()-selectionLifetime;
  }
  remember(r:EmployeeChannelRecord,members:Awaited<ReturnType<DirectoryMemberSearch['search']>>['members']){
    this.store.transaction(()=>{
      this.store.run('DELETE FROM wecom_bot_contacts WHERE connection_id=? AND (source_id<>? OR auth_revision<>?)',r.id,r.sourceId,r.authRevision);
      for(const member of members)this.store.run(`INSERT INTO wecom_bot_contacts VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(connection_id,source_id,auth_revision,user_id) DO UPDATE SET display_name=excluded.display_name,
        department_paths=excluded.department_paths,found_at=excluded.found_at`,r.id,r.sourceId,r.authRevision,
        member.id,member.displayName,JSON.stringify(member.departmentPaths),this.now());
      this.store.run(`DELETE FROM wecom_bot_contacts WHERE connection_id=? AND user_id IN
        (SELECT user_id FROM wecom_bot_contacts WHERE connection_id=? ORDER BY found_at DESC,user_id LIMIT -1 OFFSET 500)`,r.id,r.id);
    });
  }
  async verifyRecipient(r:EmployeeChannelRecord,userId:string,adapter:DirectoryMemberSearch){
    const candidate=this.get(r,userId);
    if(!weComSearchIdentityVerified(r)||!candidate)throw new DirectoryError('authorization_denied');
    const result=await adapter.search([candidate.display_name]);
    if(!result.members.some(member=>member.id===userId))throw new DirectoryError('authorization_denied');
  }
  remove(connectionId:string){
    this.store.run('DELETE FROM wecom_bot_contacts WHERE connection_id=?',connectionId);
  }
}
