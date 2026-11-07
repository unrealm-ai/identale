import type { TaskCommand } from '../../task-runtime.js';
import type { Store } from '../../store.js';

/** Runtime binding copies belong to the transport adapter, not TaskRepository. */
export class SqliteTaskRuntimeContextRetention {
  constructor(private readonly store: Store) {}
  scrubContext(runId: string): void {
    if (!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='task_host_bindings'")) return;
    const binding = this.store.one<{command_json: string}>('SELECT command_json FROM task_host_bindings WHERE run_id=?', runId);
    if (!binding) return;
    const command = JSON.parse(binding.command_json) as TaskCommand;
    command.context.messages = command.context.messages.map(message => ({id: message.id, role: message.role, text: '', expired: true}));
    this.store.run('UPDATE task_host_bindings SET command_json=? WHERE run_id=?', JSON.stringify(command), runId);
  }
}
