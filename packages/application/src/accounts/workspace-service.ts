import type { AccountRepository, WorkspaceRepository, AccountSecurity, AccountWorkspace } from './ports.js';
import { accountFail as fail, accountInput as input, accountString as str } from './validation.js';
export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository, private readonly accounts: AccountRepository, private readonly security: AccountSecurity, private readonly now: () => number) {}
  get(userId: string, id: string): AccountWorkspace { return this.repository.find(userId, str(id)) ?? fail(403, 'workspace_forbidden'); }
  list(userId: string) { return this.repository.list(userId); }
  create(userId: string, name: string): AccountWorkspace {
    const workspace: AccountWorkspace = {id: this.security.id(), name, memberId: this.security.id(), role: 'owner'};
    this.repository.insert(workspace, userId);
    this.accounts.audit(this.now(), 'workspace.created', userId, workspace.id);
    return workspace;
  }
  createFromInput(userId: string, value: unknown) { const body = input(value, ['name']); return this.accounts.transaction(() => this.create(userId, str(body['name']))); }
  rename(userId: string, workspaceId: string, value: unknown): AccountWorkspace {
    const body = input(value, ['name', 'expectedName']);
    const name = str(body['name']), expectedName = str(body['expectedName']);
    return this.accounts.transaction(() => {
      this.requireAdmin(userId, workspaceId);
      if (!this.repository.rename(workspaceId, name, expectedName)) return fail(409, 'workspace_name_conflict');
      this.accounts.audit(this.now(), 'workspace.renamed', userId, workspaceId);
      return this.get(userId, workspaceId);
    });
  }
  requireAdmin(userId:string,workspaceId:string){const selected=this.get(userId,workspaceId);if(selected.role==='member')return fail(403,'role_forbidden');return selected;}
  members(userId:string,workspaceId:string){this.requireAdmin(userId,workspaceId);return this.repository.members(workspaceId);}
  patchMember(userId:string,workspaceId:string,memberId:string,value:unknown){
    const body=input(value,['expectedVersion','role','enabled']);
    if(!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||(body.role!==undefined&&!['admin','member'].includes(String(body.role)))||(body.enabled!==undefined&&typeof body.enabled!=='boolean')||(body.role===undefined&&body.enabled===undefined))return fail(400,'invalid_member_patch');
    return this.accounts.transaction(()=>{const actor=this.requireAdmin(userId,workspaceId),members=this.repository.members(workspaceId),target=members.find(m=>m.id===memberId);if(!target)return fail(404,'member_not_found');if(target.version!==body.expectedVersion)return fail(409,'member_version_conflict');
      if(target.role==='owner')return fail(403,'owner_protected');
      const role=(body.role??target.role) as 'admin'|'member',status=body.enabled===undefined?target.status:body.enabled?'active':'disabled';
      if(target.id===actor.memberId&&(status!=='active'||role!==target.role))return fail(409,'self_member_change_forbidden');
      if((status!=='active'||role==='member')&&!members.some(m=>m.id!==target.id&&m.status==='active'&&['owner','admin'].includes(m.role)))return fail(409,'last_manager_protected');
      if(!this.repository.updateMember(workspaceId,memberId,role,status,target.version))return fail(409,'member_version_conflict');
      this.accounts.audit(this.now(),'member.updated',userId,workspaceId);return this.repository.members(workspaceId).find(m=>m.id===memberId)!;
    });
  }
  invitation(raw: string) {
    const invite = this.repository.invitation(this.security.digest(raw));
    if (!invite || invite.revoked || invite.usedBy || invite.expiresAt <= this.now()) return fail(400, 'invitation_invalid');
    const role = this.repository.inviterRole(invite.inviterMemberId, invite.workspaceId);
    if (!role || !['owner', 'admin'].includes(role) || (invite.role === 'admin' && role !== 'owner')) return fail(400, 'invitation_invalid');
    return invite;
  }
  consume(raw: string, userId: string) {
    const invite = this.invitation(raw), existing = this.repository.membershipStatus(invite.workspaceId, userId);
    if (existing && existing !== 'active') return fail(403, 'membership_inactive');
    if (!existing) this.repository.insertMember(this.security.id(), invite.workspaceId, userId, invite.role);
    if (!invite.reusable) {
      this.repository.consumeInvitation(this.security.digest(raw), userId);
      this.accounts.audit(this.now(), 'invitation.consumed', userId, invite.workspaceId);
    } else if (!existing) {
      this.accounts.audit(this.now(), 'invitation.accepted', userId, invite.workspaceId);
    }
    return this.get(userId, invite.workspaceId);
  }
  invite(userId: string, workspaceId: string, value: unknown) {
    const selected = this.get(userId, workspaceId), body = input(value, ['role', 'expiresInHours']);
    const role = body['role'] ?? 'member';
    if (role !== 'member' && role !== 'admin') return fail(400, 'invalid_role');
    if (selected.role === 'member' || (role === 'admin' && selected.role !== 'owner')) return fail(403, 'role_forbidden');
    const hours = body['expiresInHours'] ?? 24;
    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 180 * 24) return fail(400, 'invalid_expiry');
    const raw = this.security.token(), expiresAt = this.now() + hours * 3600000;
    this.accounts.transaction(() => {
      this.repository.insertInvitation(this.security.digest(raw), {workspaceId: selected.id, inviterMemberId: selected.memberId, role, expiresAt, revoked: false, usedBy: null, reusable: true});
      this.accounts.audit(this.now(), 'invitation.created', userId, selected.id);
    });
    return {token: raw, expiresAt, workspaceId: selected.id, role};
  }
  inspect(value: unknown) { const body = input(value, ['token']), invite = this.invitation(str(body['token'], 32, 256)); return {workspace: this.repository.summary(invite.workspaceId), role: invite.role, expiresAt: invite.expiresAt}; }
  accept(userId: string, value: unknown) { const body = input(value, ['token']); return this.accounts.transaction(() => this.consume(str(body['token'], 32, 256), userId)); }
}
