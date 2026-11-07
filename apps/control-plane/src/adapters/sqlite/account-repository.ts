import type { AccountRepository, AccountUser } from '@dentity/application';
import type { Store } from '../../store.js';
export class SqliteAccountRepository implements AccountRepository {
  constructor(private readonly store: Store) {}
  transaction<T>(work: () => T): T { return this.store.transaction(work); }
  audit(at: number, action: string, userId: string, workspaceId: string | null) { this.store.run('INSERT INTO audit(at,action,user_id,workspace_id) VALUES(?,?,?,?)', at, action, userId, workspaceId); }
  sessionUser(tokenHash: string, now: number) { return this.store.one<AccountUser>(`SELECT u.id,u.username,u.display_name AS displayName FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked=0 AND s.expires_at>? AND u.status='active'`, tokenHash, now); }
  credentialByUsername(username: string) { return this.store.one<AccountUser & {passwordHash: string; status: string}>(`SELECT u.id,u.username,u.display_name AS displayName,u.status,c.password_hash AS passwordHash FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.username=?`, username); }
  credentialById(id: string) { return this.store.one<{passwordHash: string; status: string}>('SELECT u.status,c.password_hash AS passwordHash FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=?', id); }
  usernameExists(username: string) { return !!this.store.one('SELECT id FROM users WHERE username=?', username); }
  insertUser(user: AccountUser, passwordHash: string) {
    this.store.run('INSERT INTO users(id,username,display_name) VALUES(?,?,?)', user.id, user.username, user.displayName);
    this.store.run('INSERT INTO credentials(user_id,password_hash) VALUES(?,?)', user.id, passwordHash);
  }
  revokeSession(tokenHash: string) { this.store.run('UPDATE sessions SET revoked=1 WHERE token_hash=?', tokenHash); }
  insertSession(tokenHash: string, userId: string, expiresAt: number) { this.store.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', tokenHash, userId, expiresAt); }
}
