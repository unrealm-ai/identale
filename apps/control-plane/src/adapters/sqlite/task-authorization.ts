import { TaskError, type TaskAuthorizationPort, type TaskScope } from '@dentity/application';
import type { Store } from '../../store.js';

/** Baseline web authorization for deployments without capability configuration. */
export class SqliteTaskAuthorization implements TaskAuthorizationPort {
  constructor(private readonly store: Store) {}
  authorizeEntity(scope: TaskScope) {
    if(scope.principal)throw new TaskError(403,'entity_use_forbidden');
    if (!this.store.one("SELECT e.id FROM entities e JOIN members m ON m.workspace_id=e.workspace_id JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=e.workspace_id WHERE e.id=? AND e.workspace_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND w.status='active' AND e.own_web_use=1 AND e.web_use_user_id=?", scope.entityId, scope.workspaceId, scope.userId??null, scope.userId??null)) throw new TaskError(403, 'entity_use_forbidden');
  }
}
