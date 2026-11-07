import type { AccountRepository, AccountSecurity, AccountUser, PasswordHasher } from './ports.js';
import { WorkspaceService } from './workspace-service.js';
import { accountFail as fail, accountInput as input, accountString as str, accountUsername as username, accountPassword as password } from './validation.js';
export class AccountService {
  private dummyHash = '';
  constructor(private readonly repository: AccountRepository, private readonly workspaces: WorkspaceService, private readonly security: AccountSecurity, private readonly passwords: PasswordHasher, private readonly now: () => number, private readonly sessionTtlMs: number) {}
  async initialize() { this.dummyHash = await this.passwords.hash(this.security.token()); }
  authenticate(raw: string | undefined): AccountUser { if (!raw) return fail(401, 'unauthenticated'); return this.repository.sessionUser(this.security.digest(raw), this.now()) ?? fail(401, 'unauthenticated'); }
  private session(userId: string, previous: string | undefined) {
    if (previous) this.repository.revokeSession(this.security.digest(previous));
    const raw = this.security.token();
    this.repository.insertSession(this.security.digest(raw), userId, this.now() + this.sessionTtlMs);
    return raw;
  }
  async register(value: unknown, previous?: string) {
    const body = input(value, ['username', 'password', 'displayName', 'workspaceName', 'invitationToken']);
    const name = username(body['username']), secret = password(body['password'], true);
    const displayName = body['displayName'] === undefined ? name : str(body['displayName']);
    const workspaceName = body['workspaceName'] === undefined ? `${displayName}'s workspace` : str(body['workspaceName']);
    const inviteToken = body['invitationToken'] === undefined ? undefined : str(body['invitationToken'], 32, 256);
    if (inviteToken && body['workspaceName'] !== undefined) return fail(400, 'invitation_workspace_conflict');
    if (inviteToken) this.workspaces.invitation(inviteToken);
    const hash = await this.passwords.hash(secret);
    return this.repository.transaction(() => {
      if (this.repository.usernameExists(name)) return fail(409, 'username_unavailable');
      const user = {id: this.security.id(), username: name, displayName};
      this.repository.insertUser(user, hash);
      const workspace = inviteToken ? this.workspaces.consume(inviteToken, user.id) : this.workspaces.create(user.id, workspaceName);
      const sessionToken = this.session(user.id, previous);
      this.repository.audit(this.now(), 'account.registered', user.id, workspace.id);
      return {user, workspace, sessionToken};
    });
  }
  async login(value: unknown, previous?: string) {
    const body = input(value, ['username', 'password']), name = username(body['username']), secret = password(body['password']);
    const candidate = this.repository.credentialByUsername(name);
    if (!this.dummyHash) throw new Error('Account service must be initialized');
    const valid = await this.passwords.verify(candidate?.passwordHash ?? this.dummyHash, secret);
    if (!valid || !candidate || candidate.status !== 'active') return fail(401, 'invalid_credentials');
    const user = {id: candidate.id, username: candidate.username, displayName: candidate.displayName};
    const sessionToken = this.repository.transaction(() => {
      const current = this.repository.credentialById(user.id);
      if (!current || current.status !== 'active' || current.passwordHash !== candidate.passwordHash) return fail(401, 'invalid_credentials');
      const raw = this.session(user.id, previous);
      this.repository.audit(this.now(), 'account.login', user.id, null);
      return raw;
    });
    return {user, workspaces: this.workspaces.list(user.id), sessionToken};
  }
  logout(value: unknown, raw: string | undefined) { input(value, []); if (raw) this.repository.revokeSession(this.security.digest(raw)); }
}
