/** Persisted ownership only. Configuration snapshots belong in runtime memory, not its database. */
export type StorageOwner = 'platform' | 'runtime';

export const PLATFORM_TABLES = [
  'users', 'credentials', 'workspaces', 'members', 'sessions', 'invitations',
  'entities', 'entity_create_operations', 'employee_creation_operations', 'audit',
  'entity_web_policies', 'entity_directory_policies', 'employee_handoff_policies', 'capability_packages',
  'model_profiles', 'model_catalog', 'entity_model_bindings', 'workspace_model_defaults',
  'model_selection_epochs', 'model_catalog_migrations', 'skill_resource_versions',
  'skill_resource_state', 'workspace_mcp_versions', 'workspace_mcp_state',
  'employee_channel_connections', 'employee_channel_verification_events',
  'employee_channel_audit', 'employee_channel_directory_credentials',
  'wecom_bot_contacts', 'wecom_member_verification_requests',
  'channel_observation_receipts',
  'directory_sync_tasks', 'directory_snapshot_users', 'directory_snapshot_aliases',
  'directory_alias_projection_meta', 'directory_snapshot_departments',
  'directory_sync_history', 'directory_sync_part_state', 'directory_sync_history_parts',
  'trigger_bindings', 'trigger_credentials','employee_human_rules','employee_group_sharing_rules','workspace_work_item_settings',
] as const;

export const RUNTIME_TABLES = [
  // Legacy guess-budget tables remain owned for safe upgrades, but are unused.
  'wecom_member_verification_attempts','wecom_member_verification_notices',
  'business_resource_run_context','business_resource_authorizations','business_resource_cache_authorizations',
  'business_account_bindings','business_oauth_states','business_oauth_tokens',
  'source_material_transfers','work_item_resource_transfers',
  'message_asset_conversation_grants',
  'task_artifact_selection_inputs','task_artifact_delivery_grants','task_artifact_manifests','task_artifact_selections',
  'work_item_artifact_materials','work_item_assignment_roles','work_items','work_item_assignments','work_item_task_links','work_item_events','work_item_operations','work_item_dispatches','work_item_beta_state','work_item_tool_grants','work_item_task_tool_snapshots','work_item_intents','work_item_notifications','work_item_notification_cursor',
  'conversations', 'conversation_message_index', 'web_conversation_previews',
  'tasks', 'runs', 'task_inputs', 'task_updates', 'task_operations', 'task_outbox',
  'deliveries', 'builtin_storage_metadata', 'builtin_records', 'builtin_operations',
  'builtin_journal_scopes', 'builtin_journal_index', 'builtin_journal_heads', 'queue_scan_cursors',
  'builtin_content_refs', 'interaction_turns', 'web_private_conversations',
  'conversation_context_resets', 'scheduled_jobs', 'context_maintenance_schedules',
  'business_notification_jobs','trigger_context_scopes','trigger_context_grants','trigger_context_queries','trigger_context_resources',
  'task_completion_notifications', 'task_host_bindings', 'task_runtime_capabilities',
  'runtime_outputs', 'channel_speaker_aliases', 'channel_inbox', 'channel_deliveries',
  'channel_message_receipts', 'channel_state_reports', 'channel_ingress_owner', 'runtime_process_owner',
  'group_live_membership', 'group_live_messages', 'group_live_topic_roots',
  'group_cleanup_targets', 'group_live_batches', 'trigger_events', 'message_assets',
  'message_asset_versions', 'message_asset_run_grants', 'message_asset_links',
  'message_asset_task_selection', 'employee_lifecycle_fences',
  'group_history_grants','group_history_queries','group_history_reads','group_sharing_lineage','group_history_run_budget',
  'human_channel_notices','human_requests','human_response_messages','human_response_operations',
  'channel_discovered_groups','channel_group_mentions_seen','trigger_notification_targets','trigger_result_notifications',
  'feishu_group_evidence','feishu_group_disbanded',
] as const;

const ownership = new Map<string, StorageOwner>([
  ...PLATFORM_TABLES.map(name => [name, 'platform'] as const),
  ...RUNTIME_TABLES.map(name => [name, 'runtime'] as const),
]);
export function tableOwner(name: string): StorageOwner | undefined { return ownership.get(name); }

/** Split only the top-level table definitions, respecting literals and quoted identifiers. */
function definitions(sql: string): {head: string; parts: string[]; tail: string} {
  const start = sql.indexOf('(');
  if (start < 0) throw new Error('split_schema_not_supported');
  const parts: string[] = [];
  let depth = 1, begin = start + 1, quote = '';
  for (let i = start + 1; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      if (c === quote) { if (sql[i + 1] === quote && quote !== ']') i++; else quote = ''; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || c === '[') { quote = c === '[' ? ']' : c; continue; }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (!depth) { parts.push(sql.slice(begin, i)); return {head: sql.slice(0, start + 1), parts, tail: sql.slice(i)}; }
    }
    if (c === ',' && depth === 1) { parts.push(sql.slice(begin, i)); begin = i + 1; }
  }
  throw new Error('split_schema_not_supported');
}

/** Remove cross-domain FK constraints only; their stable IDs remain ordinary columns. */
export function stripCrossDomainReferences(sql: string, owner: StorageOwner): string {
  const parsed = definitions(sql);
  const parts: string[] = [];
  for (const part of parsed.parts) {
    let quote = '', referenceAt = -1;
    for (let i = 0; i < part.length; i++) {
      const c = part[i]!;
      if (quote) { if (c === quote) { if (part[i + 1] === quote && quote !== ']') i++; else quote = ''; } continue; }
      if (c === '"' || c === "'" || c === '`' || c === '[') { quote = c === '[' ? ']' : c; continue; }
      if ((i === 0 || !/[\w]/.test(part[i - 1]!)) && /^REFERENCES\b/i.test(part.slice(i))) { referenceAt = i; break; }
    }
    if (referenceAt < 0) { parts.push(part); continue; }
    const reference = part.slice(referenceAt).match(/^REFERENCES\s+("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[\w]+)\s*(?:\([^)]*\))?(?:(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:SET\s+(?:NULL|DEFAULT)|CASCADE|RESTRICT|NO\s+ACTION))|(?:\s+MATCH\s+\w+)|(?:\s+(?:NOT\s+)?DEFERRABLE)|(?:\s+INITIALLY\s+(?:DEFERRED|IMMEDIATE)))*/i);
    if (!reference) throw new Error('split_schema_not_supported');
    const target = reference[1]!.replace(/^(?:"|`|\[)|(?:"|`|\])$/g, '').replaceAll('""', '"');
    const targetOwner = tableOwner(target);
    if (!targetOwner) throw new Error(`split_unknown_reference:${target}`);
    if (targetOwner === owner) { parts.push(part); continue; }
    if (/^\s*(?:CONSTRAINT\s+(?:"[^"]+"|\w+)\s+)?FOREIGN\s+KEY\b/i.test(part)) continue;
    parts.push(part.slice(0, referenceAt) + part.slice(referenceAt + reference[0].length));
  }
  return parsed.head + parts.join(',') + parsed.tail;
}
