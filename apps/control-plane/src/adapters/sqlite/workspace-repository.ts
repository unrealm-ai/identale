import type { WorkspaceRepository, AccountWorkspace, AccountInvitation } from '@dentity/application';
import type { Store } from '../../store.js';
import type { WorkItemConfiguration } from '../../work-items/configuration.js';
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly store: Store, private readonly workItems: WorkItemConfiguration) {if(!store.all<{name:string}>('PRAGMA table_info(members)').some(c=>c.name==='version'))store.db.exec('ALTER TABLE members ADD COLUMN version INTEGER NOT NULL DEFAULT 1');}
  rename(workspaceId: string, name: string, expectedName: string) { return this.store.run("UPDATE workspaces SET name=? WHERE id=? AND name=? AND status='active'", name, workspaceId, expectedName).changes === 1; }
  members(workspaceId:string){return this.store.all<import('@dentity/application').WorkspaceMember>('SELECT m.id,m.user_id AS userId,u.display_name AS displayName,u.username,m.role,m.status,m.version FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.rowid',workspaceId);}
  updateMember(w:string,id:string,role:'admin'|'member',status:string,version:number){return this.store.run('UPDATE members SET role=?,status=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?',role,status,w,id,version).changes===1;}

  find(userId: string, workspaceId: string) { return this.store.one<AccountWorkspace>(`SELECT w.id,w.name,m.id AS memberId,m.role FROM workspaces w JOIN members m ON w.id=m.workspace_id WHERE w.id=? AND m.user_id=? AND w.status='active' AND m.status='active'`, workspaceId, userId); }
  list(userId: string) { return this.store.all<AccountWorkspace>(`SELECT w.id,w.name,m.id AS memberId,m.role FROM workspaces w JOIN members m ON w.id=m.workspace_id WHERE m.user_id=? AND w.status='active' AND m.status='active' ORDER BY w.rowid`, userId); }
  insert(workspace: AccountWorkspace, userId: string) {
    this.store.run('INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)', workspace.id, workspace.name, userId);
    this.store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES(?,?,?,'owner')", workspace.memberId, workspace.id, userId);
    this.workItems.initializeWorkspace(workspace.id);
  }
  invitation(tokenHash: string) {
    const row = this.store.one<Omit<AccountInvitation, 'revoked'> & {revoked: number}>('SELECT workspace_id AS workspaceId,inviter_member_id AS inviterMemberId,role,expires_at AS expiresAt,revoked,used_by AS usedBy FROM invitations WHERE token_hash=?', tokenHash);
    return row ? {...row, revoked: Boolean(row.revoked)} : undefined;
  }
  inviterRole(memberId: string, workspaceId: string) { return this.store.one<{role: string}>(`SELECT m.role FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN users u ON u.id=m.user_id WHERE u.status='active' AND m.id=? AND m.workspace_id=? AND m.status='active' AND w.status='active'`, memberId, workspaceId)?.role; }
  membershipStatus(workspaceId: string, userId: string) { return this.store.one<{status: string}>('SELECT status FROM members WHERE workspace_id=? AND user_id=?', workspaceId, userId)?.status; }
  insertMember(id: string, workspaceId: string, userId: string, role: 'admin' | 'member') { this.store.run('INSERT INTO members(id,workspace_id,user_id,role) VALUES(?,?,?,?)', id, workspaceId, userId, role); }
  consumeInvitation(tokenHash: string, userId: string) { this.store.run('UPDATE invitations SET used_by=? WHERE token_hash=?', userId, tokenHash); }
  insertInvitation(tokenHash: string, invitation: AccountInvitation) { this.store.run('INSERT INTO invitations(token_hash,workspace_id,inviter_member_id,role,expires_at) VALUES(?,?,?,?,?)', tokenHash, invitation.workspaceId, invitation.inviterMemberId, invitation.role, invitation.expiresAt); }
  summary(workspaceId: string) { return this.store.one<{id: string; name: string}>('SELECT id,name FROM workspaces WHERE id=?', workspaceId); }
}
