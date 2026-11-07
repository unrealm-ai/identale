import type { ThinkingLevel } from '@dentity/contracts';
export interface AccountUser { id: string; username: string; displayName: string }
export interface AccountWorkspace { id: string; name: string; memberId: string; role: 'owner' | 'admin' | 'member' }
export interface AccountInvitation { workspaceId: string; inviterMemberId: string; role: 'admin' | 'member'; expiresAt: number; revoked: boolean; usedBy: string | null }
export interface AccountEntity { avatarPreset?:string|null; enabled?: boolean; lifecycleRevision?: number; id: string; workspaceId: string; name: string; description: string; ownerMemberId: string; createdByMemberId: string; ownWebUse: boolean; webUseUserId: string; interactionRuntime: string; executionThinkingLevel: ThinkingLevel }
export interface AccountSecurity { id(): string; token(): string; digest(value: string): string }
export interface PasswordHasher { hash(value: string): Promise<string>; verify(hash: string, value: string): Promise<boolean> }
export interface AccountRepository {
  transaction<T>(work: () => T): T;
  audit(at: number, action: string, userId: string, workspaceId: string | null): void;
  sessionUser(tokenHash: string, now: number): AccountUser | undefined;
  credentialByUsername(username: string): (AccountUser & {passwordHash: string; status: string}) | undefined;
  credentialById(id: string): {passwordHash: string; status: string} | undefined;
  usernameExists(username: string): boolean;
  insertUser(user: AccountUser, passwordHash: string): void;
  revokeSession(tokenHash: string): void;
  insertSession(tokenHash: string, userId: string, expiresAt: number): void;
}
export interface WorkspaceMember {id:string;userId:string;displayName:string;username:string;role:'owner'|'admin'|'member';status:string;version:number}
export interface WorkspaceRepository {
  members(workspaceId:string): WorkspaceMember[];
  rename(workspaceId: string, name: string, expectedName: string): boolean;
  updateMember(workspaceId:string,id:string,role:'admin'|'member',status:string,version:number):boolean;
  find(userId: string, workspaceId: string): AccountWorkspace | undefined;
  list(userId: string): AccountWorkspace[];
  insert(workspace: AccountWorkspace, userId: string): void;
  invitation(tokenHash: string): AccountInvitation | undefined;
  inviterRole(memberId: string, workspaceId: string): string | undefined;
  membershipStatus(workspaceId: string, userId: string): string | undefined;
  insertMember(id: string, workspaceId: string, userId: string, role: 'admin' | 'member'): void;
  consumeInvitation(tokenHash: string, userId: string): void;
  insertInvitation(tokenHash: string, invitation: AccountInvitation): void;
  summary(workspaceId: string): {id: string; name: string} | undefined;
}
export interface EntityRepository {
  list(workspaceId: string): AccountEntity[];
  find(workspaceId: string, entityId: string): AccountEntity | undefined;
  createOperation(userId: string, workspaceId: string, operationId: string): {requestHash: string; entityId: string} | undefined;
  activeOwner(memberId: string, workspaceId: string): boolean;
  insert(entity: AccountEntity): void;
  recordCreateOperation(userId: string, workspaceId: string, operationId: string, requestHash: string, entityId: string): void;
  update(workspaceId: string, entityId: string, patch: {avatarPreset?:string|null;name?: string; description?: string; executionThinkingLevel?: ThinkingLevel}): void;
}
