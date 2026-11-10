/** Frozen V1 durable schema. Do not edit released migrations; add a new version instead.
 * Captured from isolated combined bootstrap plus optional host/OAuth/artifact and split-only schemas.
 * TEMP configuration projections and legacy migration staging tables are excluded. */
export const BASELINE_V1 = [
  {
    "type": "table",
    "name": "audit",
    "tbl_name": "audit",
    "sql": "CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT)"
  },
  {
    "type": "table",
    "name": "builtin_content_refs",
    "tbl_name": "builtin_content_refs",
    "sql": "CREATE TABLE builtin_content_refs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),record_ref TEXT NOT NULL,expires_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "builtin_journal_heads",
    "tbl_name": "builtin_journal_heads",
    "sql": "CREATE TABLE builtin_journal_heads(resource_id TEXT PRIMARY KEY,version TEXT NOT NULL,refs_json TEXT NOT NULL,checksum TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "builtin_journal_index",
    "tbl_name": "builtin_journal_index",
    "sql": "CREATE TABLE builtin_journal_index(sequence INTEGER PRIMARY KEY AUTOINCREMENT,resource_id TEXT NOT NULL,record_id TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER NOT NULL,execution_key TEXT,run_key TEXT,UNIQUE(resource_id,record_id))"
  },
  {
    "type": "table",
    "name": "builtin_journal_scopes",
    "tbl_name": "builtin_journal_scopes",
    "sql": "CREATE TABLE builtin_journal_scopes(resource_id TEXT PRIMARY KEY,format_version INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "builtin_operations",
    "tbl_name": "builtin_operations",
    "sql": "CREATE TABLE builtin_operations(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT, created_at INTEGER, closed_at INTEGER)"
  },
  {
    "type": "table",
    "name": "builtin_records",
    "tbl_name": "builtin_records",
    "sql": "CREATE TABLE builtin_records(key TEXT PRIMARY KEY,version INTEGER NOT NULL,json TEXT NOT NULL, created_at INTEGER, closed_at INTEGER)"
  },
  {
    "type": "table",
    "name": "builtin_storage_metadata",
    "tbl_name": "builtin_storage_metadata",
    "sql": "CREATE TABLE builtin_storage_metadata(id INTEGER PRIMARY KEY CHECK(id=1), database_id TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "business_account_bindings",
    "tbl_name": "business_account_bindings",
    "sql": "CREATE TABLE business_account_bindings(workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,connection_id TEXT NOT NULL,binding_version TEXT NOT NULL,requester_id TEXT NOT NULL,requester_namespace TEXT NOT NULL,provider TEXT NOT NULL,account_id TEXT NOT NULL,authorization_revision TEXT NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,entity_id,connection_id,requester_id,requester_namespace))"
  },
  {
    "type": "table",
    "name": "business_notification_jobs",
    "tbl_name": "business_notification_jobs",
    "sql": "CREATE TABLE business_notification_jobs(id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,scope_json TEXT NOT NULL,target_json TEXT NOT NULL,conversation_id TEXT,data_ref TEXT NOT NULL,state TEXT NOT NULL,turn_id TEXT NOT NULL,reply_ref TEXT,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,published_at INTEGER, attempt INTEGER NOT NULL DEFAULT 0, delivery_state TEXT NOT NULL DEFAULT 'not_started', delivery_error TEXT)"
  },
  {
    "type": "table",
    "name": "business_oauth_states",
    "tbl_name": "business_oauth_states",
    "sql": "CREATE TABLE business_oauth_states(state_hash TEXT PRIMARY KEY,principal_hash TEXT NOT NULL,connection_id TEXT NOT NULL,expires_at INTEGER NOT NULL,sealed TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "business_oauth_tokens",
    "tbl_name": "business_oauth_tokens",
    "sql": "CREATE TABLE business_oauth_tokens(consent_key TEXT PRIMARY KEY,connection_id TEXT NOT NULL,requester_id TEXT NOT NULL,expires_at INTEGER NOT NULL,sealed TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "business_resource_authorizations",
    "tbl_name": "business_resource_authorizations",
    "sql": "CREATE TABLE business_resource_authorizations(asset_id TEXT NOT NULL,run_id TEXT NOT NULL,read_kind TEXT NOT NULL,resource_key TEXT NOT NULL,request_json TEXT NOT NULL,grant_json TEXT NOT NULL,PRIMARY KEY(asset_id,run_id,read_kind,resource_key))"
  },
  {
    "type": "table",
    "name": "business_resource_cache_authorizations",
    "tbl_name": "business_resource_cache_authorizations",
    "sql": "CREATE TABLE business_resource_cache_authorizations(asset_id TEXT NOT NULL,read_kind TEXT NOT NULL,grant_json TEXT NOT NULL,PRIMARY KEY(asset_id,read_kind))"
  },
  {
    "type": "table",
    "name": "business_resource_run_context",
    "tbl_name": "business_resource_run_context",
    "sql": "CREATE TABLE business_resource_run_context(asset_id TEXT NOT NULL,run_id TEXT NOT NULL,request_json TEXT NOT NULL,PRIMARY KEY(asset_id,run_id))"
  },
  {
    "type": "table",
    "name": "capability_packages",
    "tbl_name": "capability_packages",
    "sql": "CREATE TABLE capability_packages (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL,config_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "channel_deliveries",
    "tbl_name": "channel_deliveries",
    "sql": "CREATE TABLE channel_deliveries(id TEXT PRIMARY KEY,scope_json TEXT NOT NULL,target_json TEXT NOT NULL,text TEXT,status TEXT NOT NULL,task_delivery_id TEXT,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,error TEXT,message_id TEXT,provider_request_id TEXT,retry_at INTEGER NOT NULL DEFAULT 0, correlation_json TEXT, lane TEXT, connection_id TEXT, priority INTEGER NOT NULL DEFAULT 0, blocking INTEGER NOT NULL DEFAULT 1, lease_owner TEXT, attempt_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, send_deadline INTEGER, closed_at INTEGER, receipt_query_state TEXT, receipt_query_attempts INTEGER NOT NULL DEFAULT 0, receipt_query_at INTEGER, receipt_query_deadline INTEGER, receipt_query_token TEXT, receipt_query_lease_until INTEGER)"
  },
  {
    "type": "table",
    "name": "channel_discovered_groups",
    "tbl_name": "channel_discovered_groups",
    "sql": "CREATE TABLE channel_discovered_groups(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,connection_id TEXT NOT NULL,app_id TEXT NOT NULL,tenant_id TEXT NOT NULL,binding_version TEXT NOT NULL,chat_id TEXT NOT NULL,name TEXT,preview TEXT NOT NULL,last_message_id TEXT NOT NULL,last_message_at INTEGER NOT NULL,membership_at INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 1)"
  },
  {
    "type": "table",
    "name": "channel_group_mentions_seen",
    "tbl_name": "channel_group_mentions_seen",
    "sql": "CREATE TABLE channel_group_mentions_seen(id TEXT PRIMARY KEY)"
  },
  {
    "type": "table",
    "name": "channel_inbox",
    "tbl_name": "channel_inbox",
    "sql": "CREATE TABLE channel_inbox(id TEXT PRIMARY KEY,lane TEXT NOT NULL,connection_id TEXT NOT NULL,binding_version TEXT NOT NULL,scope_json TEXT NOT NULL,event_json TEXT,status TEXT NOT NULL,conversation_id TEXT,turn_id TEXT,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,error TEXT,retry_at INTEGER NOT NULL DEFAULT 0, employee_use_admitted INTEGER, source_key TEXT, payload_hash TEXT, lease_owner TEXT, submitted_at INTEGER, submit_deadline INTEGER, accepted_at INTEGER, committed_at INTEGER, closed_at INTEGER, input_text TEXT, history_batch_id TEXT, event_cursor TEXT NOT NULL DEFAULT '0', rt_terminal INTEGER NOT NULL DEFAULT 0)"
  },
  {
    "type": "table",
    "name": "channel_ingress_owner",
    "tbl_name": "channel_ingress_owner",
    "sql": "CREATE TABLE channel_ingress_owner(id INTEGER PRIMARY KEY CHECK(id=1),incarnation TEXT NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "channel_message_receipts",
    "tbl_name": "channel_message_receipts",
    "sql": "CREATE TABLE channel_message_receipts(id TEXT NOT NULL,kind TEXT NOT NULL,lane TEXT NOT NULL,connection_id TEXT NOT NULL,status TEXT NOT NULL,conversation_id TEXT,turn_id TEXT,task_delivery_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT,message_id TEXT,provider_request_id TEXT, source_key TEXT, payload_hash TEXT,PRIMARY KEY(id,kind))"
  },
  {
    "type": "table",
    "name": "channel_observation_receipts",
    "tbl_name": "channel_observation_receipts",
    "sql": "CREATE TABLE channel_observation_receipts(id TEXT PRIMARY KEY,body_digest TEXT NOT NULL,response_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "channel_speaker_aliases",
    "tbl_name": "channel_speaker_aliases",
    "sql": "CREATE TABLE channel_speaker_aliases(conversation_id TEXT NOT NULL,actor_key TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(conversation_id,actor_key),UNIQUE(conversation_id,ordinal))"
  },
  {
    "type": "table",
    "name": "channel_state_reports",
    "tbl_name": "channel_state_reports",
    "sql": "CREATE TABLE channel_state_reports(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,body_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','accepted','conflict')),created_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "context_maintenance_schedules",
    "tbl_name": "context_maintenance_schedules",
    "sql": "CREATE TABLE context_maintenance_schedules(session_id TEXT PRIMARY KEY,policy_revision TEXT NOT NULL,next_due_at INTEGER NOT NULL,last_history_version INTEGER NOT NULL DEFAULT 0,last_context_fingerprint TEXT)"
  },
  {
    "type": "table",
    "name": "conversation_context_resets",
    "tbl_name": "conversation_context_resets",
    "sql": "CREATE TABLE conversation_context_resets(conversation_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "conversation_message_index",
    "tbl_name": "conversation_message_index",
    "sql": "CREATE TABLE conversation_message_index (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, record_ref TEXT NOT NULL, created_at INTEGER NOT NULL, simulated INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "conversations",
    "tbl_name": "conversations",
    "sql": "CREATE TABLE \"conversations\" (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT NOT NULL REFERENCES entities(id), user_id TEXT REFERENCES users(id), channel TEXT NOT NULL DEFAULT 'web', operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, owner_key TEXT NOT NULL DEFAULT '', scope_json TEXT, mode TEXT NOT NULL DEFAULT 'real', expires_at INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,entity_id,operation_id))"
  },
  {
    "type": "table",
    "name": "credentials",
    "tbl_name": "credentials",
    "sql": "CREATE TABLE credentials (user_id TEXT PRIMARY KEY REFERENCES users(id), password_hash TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "deliveries",
    "tbl_name": "deliveries",
    "sql": "CREATE TABLE deliveries (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), event_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(task_id,event_id))"
  },
  {
    "type": "table",
    "name": "directory_alias_projection_meta",
    "tbl_name": "directory_alias_projection_meta",
    "sql": "CREATE TABLE directory_alias_projection_meta(version INTEGER PRIMARY KEY)"
  },
  {
    "type": "table",
    "name": "directory_snapshot_aliases",
    "tbl_name": "directory_snapshot_aliases",
    "sql": "CREATE TABLE directory_snapshot_aliases(task_id TEXT NOT NULL,alias_namespace TEXT NOT NULL,alias_id TEXT NOT NULL,person_namespace TEXT NOT NULL,person_id TEXT NOT NULL,PRIMARY KEY(task_id,alias_namespace,alias_id,person_namespace,person_id))"
  },
  {
    "type": "table",
    "name": "directory_snapshot_departments",
    "tbl_name": "directory_snapshot_departments",
    "sql": "CREATE TABLE directory_snapshot_departments(task_id TEXT NOT NULL,namespace TEXT NOT NULL,external_id TEXT NOT NULL,department_json TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(task_id,namespace,external_id))"
  },
  {
    "type": "table",
    "name": "directory_snapshot_memberships",
    "tbl_name": "directory_snapshot_memberships",
    "sql": "CREATE TABLE directory_snapshot_memberships(task_id TEXT NOT NULL,namespace TEXT NOT NULL,external_id TEXT NOT NULL,department_id TEXT NOT NULL,PRIMARY KEY(task_id,namespace,external_id,department_id))"
  },
  {
    "type": "table",
    "name": "directory_snapshot_scope",
    "tbl_name": "directory_snapshot_scope",
    "sql": "CREATE TABLE directory_snapshot_scope(task_id TEXT PRIMARY KEY,scope_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "directory_snapshot_search",
    "tbl_name": "directory_snapshot_search",
    "sql": "CREATE TABLE directory_snapshot_search(task_id TEXT NOT NULL,kind TEXT NOT NULL,namespace TEXT NOT NULL,external_id TEXT NOT NULL,display_name TEXT NOT NULL,search_name TEXT NOT NULL,parent_id TEXT,PRIMARY KEY(task_id,kind,namespace,external_id))"
  },
  {
    "type": "table",
    "name": "directory_snapshot_users",
    "tbl_name": "directory_snapshot_users",
    "sql": "CREATE TABLE directory_snapshot_users(task_id TEXT NOT NULL,namespace TEXT NOT NULL,external_id TEXT NOT NULL,person_json TEXT NOT NULL,aliases_json TEXT NOT NULL,last_access INTEGER NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(task_id,namespace,external_id))"
  },
  {
    "type": "table",
    "name": "directory_sync_history",
    "tbl_name": "directory_sync_history",
    "sql": "CREATE TABLE directory_sync_history(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,trigger_kind TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,snapshot_version INTEGER,user_count INTEGER NOT NULL DEFAULT 0,department_count INTEGER NOT NULL DEFAULT 0,error_json TEXT, source_version TEXT NOT NULL DEFAULT '')"
  },
  {
    "type": "table",
    "name": "directory_sync_history_parts",
    "tbl_name": "directory_sync_history_parts",
    "sql": "CREATE TABLE directory_sync_history_parts(history_id TEXT NOT NULL,task_id TEXT NOT NULL,part_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,version INTEGER NOT NULL,last_success INTEGER,user_count INTEGER NOT NULL DEFAULT 0,department_count INTEGER NOT NULL DEFAULT 0,error_json TEXT,PRIMARY KEY(history_id,part_id))"
  },
  {
    "type": "table",
    "name": "directory_sync_part_state",
    "tbl_name": "directory_sync_part_state",
    "sql": "CREATE TABLE directory_sync_part_state(task_id TEXT NOT NULL,part_id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,last_success INTEGER,PRIMARY KEY(task_id,part_id))"
  },
  {
    "type": "table",
    "name": "directory_sync_tasks",
    "tbl_name": "directory_sync_tasks",
    "sql": "CREATE TABLE directory_sync_tasks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,entity_name TEXT NOT NULL,connection_id TEXT NOT NULL,provider TEXT NOT NULL,app_id TEXT NOT NULL,source_version TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,period_ms INTEGER NOT NULL DEFAULT 3600000,version INTEGER NOT NULL DEFAULT 1,next_at INTEGER,running INTEGER NOT NULL DEFAULT 0,last_started INTEGER,last_finished INTEGER,last_success INTEGER,last_result TEXT NOT NULL DEFAULT 'never',error_json TEXT,snapshot_version INTEGER NOT NULL DEFAULT 0,invalidated INTEGER NOT NULL DEFAULT 0, full_snapshot INTEGER NOT NULL DEFAULT 0,UNIQUE(workspace_id,connection_id))"
  },
  {
    "type": "table",
    "name": "employee_channel_audit",
    "tbl_name": "employee_channel_audit",
    "sql": "CREATE TABLE employee_channel_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,connection_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "employee_channel_connections",
    "tbl_name": "employee_channel_connections",
    "sql": "CREATE TABLE employee_channel_connections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),provider TEXT NOT NULL,app_id TEXT NOT NULL,bot_id TEXT,revision INTEGER NOT NULL,state_version INTEGER NOT NULL,record_json TEXT NOT NULL,UNIQUE(entity_id,provider),UNIQUE(workspace_id,provider,app_id),UNIQUE(workspace_id,provider,bot_id))"
  },
  {
    "type": "table",
    "name": "employee_channel_verification_events",
    "tbl_name": "employee_channel_verification_events",
    "sql": "CREATE TABLE employee_channel_verification_events(connection_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(connection_id,event_id))"
  },
  {
    "type": "table",
    "name": "employee_creation_operations",
    "tbl_name": "employee_creation_operations",
    "sql": "CREATE TABLE employee_creation_operations (\n    user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n    operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id),\n    PRIMARY KEY(user_id, workspace_id, operation_id))"
  },
  {
    "type": "table",
    "name": "employee_group_sharing_rules",
    "tbl_name": "employee_group_sharing_rules",
    "sql": "CREATE TABLE employee_group_sharing_rules(workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,rules_json TEXT NOT NULL,PRIMARY KEY(workspace_id,entity_id))"
  },
  {
    "type": "table",
    "name": "employee_handoff_policies",
    "tbl_name": "employee_handoff_policies",
    "sql": "CREATE TABLE employee_handoff_policies(entity_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,version INTEGER NOT NULL,allow_all INTEGER NOT NULL CHECK(allow_all IN(0,1)),scope_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "employee_human_rules",
    "tbl_name": "employee_human_rules",
    "sql": "CREATE TABLE employee_human_rules(workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL DEFAULT 1,rules_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(workspace_id,entity_id))"
  },
  {
    "type": "table",
    "name": "employee_lifecycle_fences",
    "tbl_name": "employee_lifecycle_fences",
    "sql": "CREATE TABLE employee_lifecycle_fences (\n workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,\n target_enabled INTEGER NOT NULL CHECK(target_enabled IN (0,1)),\n source_enabled INTEGER NOT NULL CHECK(source_enabled IN (0,1)), source_revision INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('reserved','committed')), created_at INTEGER NOT NULL,\n PRIMARY KEY(workspace_id,entity_id)\n)"
  },
  {
    "type": "table",
    "name": "entities",
    "tbl_name": "entities",
    "sql": "CREATE TABLE entities (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, owner_member_id TEXT NOT NULL REFERENCES members(id), created_by_member_id TEXT NOT NULL REFERENCES members(id), own_web_use INTEGER NOT NULL, web_use_user_id TEXT NOT NULL REFERENCES users(id), interaction_runtime TEXT NOT NULL, lifecycle_enabled INTEGER NOT NULL DEFAULT 1 CHECK(lifecycle_enabled IN (0,1)), lifecycle_revision INTEGER NOT NULL DEFAULT 1, execution_thinking_level TEXT NOT NULL DEFAULT 'medium' CHECK(execution_thinking_level IN ('none','low','medium','high')), model_settings_revision INTEGER NOT NULL DEFAULT 0, avatar_preset TEXT, initial_channel_defaults_json TEXT NOT NULL DEFAULT '{}', description TEXT NOT NULL DEFAULT '', trigger_history_policy TEXT NOT NULL DEFAULT 'isolated' CHECK(trigger_history_policy IN('isolated','employee_shared','business_key')), trigger_policy_revision INTEGER NOT NULL DEFAULT 1)"
  },
  {
    "type": "table",
    "name": "entity_create_operations",
    "tbl_name": "entity_create_operations",
    "sql": "CREATE TABLE entity_create_operations (user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(user_id,workspace_id,operation_id))"
  },
  {
    "type": "table",
    "name": "entity_directory_policies",
    "tbl_name": "entity_directory_policies",
    "sql": "CREATE TABLE entity_directory_policies(entity_id TEXT PRIMARY KEY REFERENCES entities(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision INTEGER NOT NULL,allow_json TEXT NOT NULL,deny_json TEXT NOT NULL, channel_policies_json TEXT NOT NULL DEFAULT '[]', allow_group_members INTEGER NOT NULL DEFAULT 0 CHECK(allow_group_members IN (0,1)))"
  },
  {
    "type": "table",
    "name": "entity_model_bindings",
    "tbl_name": "entity_model_bindings",
    "sql": "CREATE TABLE entity_model_bindings (\n      entity_id TEXT PRIMARY KEY REFERENCES entities(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n      profile_id TEXT NOT NULL REFERENCES model_catalog(id)\n    )"
  },
  {
    "type": "table",
    "name": "entity_web_policies",
    "tbl_name": "entity_web_policies",
    "sql": "CREATE TABLE entity_web_policies (entity_id TEXT PRIMARY KEY REFERENCES entities(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision INTEGER NOT NULL,allow_json TEXT NOT NULL,deny_json TEXT NOT NULL, allow_workspace_members INTEGER NOT NULL DEFAULT 0 CHECK(allow_workspace_members IN (0,1)))"
  },
  {
    "type": "table",
    "name": "feishu_app_registrations",
    "tbl_name": "feishu_app_registrations",
    "sql": "CREATE TABLE feishu_app_registrations (\n      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n      entity_id TEXT NOT NULL REFERENCES entities(id), actor_id TEXT NOT NULL REFERENCES users(id),\n      operation_id TEXT NOT NULL, record_json TEXT NOT NULL,\n      UNIQUE(workspace_id,entity_id,operation_id))"
  },
  {
    "type": "table",
    "name": "feishu_group_disbanded",
    "tbl_name": "feishu_group_disbanded",
    "sql": "CREATE TABLE feishu_group_disbanded(connection_id TEXT NOT NULL,binding_version TEXT NOT NULL,chat_id TEXT NOT NULL,PRIMARY KEY(connection_id,binding_version,chat_id))"
  },
  {
    "type": "table",
    "name": "feishu_group_evidence",
    "tbl_name": "feishu_group_evidence",
    "sql": "CREATE TABLE feishu_group_evidence(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,binding_version TEXT NOT NULL,chat_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0)"
  },
  {
    "type": "table",
    "name": "group_cleanup_targets",
    "tbl_name": "group_cleanup_targets",
    "sql": "CREATE TABLE group_cleanup_targets(connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_cutoff INTEGER NOT NULL,root_cutoff INTEGER NOT NULL,PRIMARY KEY(connection_id,chat_id))"
  },
  {
    "type": "table",
    "name": "group_history_grants",
    "tbl_name": "group_history_grants",
    "sql": "CREATE TABLE group_history_grants(run_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,credential TEXT NOT NULL,endpoint TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "group_history_queries",
    "tbl_name": "group_history_queries",
    "sql": "CREATE TABLE group_history_queries(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,state_json TEXT NOT NULL,result_json TEXT,next_cursor TEXT)"
  },
  {
    "type": "table",
    "name": "group_history_reads",
    "tbl_name": "group_history_reads",
    "sql": "CREATE TABLE group_history_reads(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,source_json TEXT NOT NULL,destination_json TEXT NOT NULL,rules_json TEXT NOT NULL,at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "group_history_run_budget",
    "tbl_name": "group_history_run_budget",
    "sql": "CREATE TABLE group_history_run_budget(run_id TEXT PRIMARY KEY,pages INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0)"
  },
  {
    "type": "table",
    "name": "group_live_batches",
    "tbl_name": "group_live_batches",
    "sql": "CREATE TABLE group_live_batches(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'accepted',released INTEGER NOT NULL DEFAULT 0,guard_json TEXT NOT NULL, retention_closed_at INTEGER, retention_compacted_at INTEGER)"
  },
  {
    "type": "table",
    "name": "group_live_membership",
    "tbl_name": "group_live_membership",
    "sql": "CREATE TABLE group_live_membership(connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,present INTEGER NOT NULL,changed_at INTEGER NOT NULL,PRIMARY KEY(connection_id,chat_id))"
  },
  {
    "type": "table",
    "name": "group_live_messages",
    "tbl_name": "group_live_messages",
    "sql": "CREATE TABLE group_live_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,family TEXT NOT NULL,connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,occurred_at INTEGER NOT NULL,raw_json TEXT NOT NULL,formatted TEXT NOT NULL,mentioned INTEGER NOT NULL,batch_id TEXT,status TEXT NOT NULL DEFAULT 'pending',UNIQUE(scope,message_id))"
  },
  {
    "type": "table",
    "name": "group_live_topic_roots",
    "tbl_name": "group_live_topic_roots",
    "sql": "CREATE TABLE group_live_topic_roots(scope TEXT PRIMARY KEY,family TEXT NOT NULL,connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,root_batch_id TEXT,committed INTEGER NOT NULL DEFAULT 0, guard_json TEXT)"
  },
  {
    "type": "table",
    "name": "group_sharing_lineage",
    "tbl_name": "group_sharing_lineage",
    "sql": "CREATE TABLE group_sharing_lineage(scope_key TEXT PRIMARY KEY,sources_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "human_channel_notices",
    "tbl_name": "human_channel_notices",
    "sql": "CREATE TABLE human_channel_notices(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,scope_json TEXT NOT NULL,target_json TEXT NOT NULL,text TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "human_requests",
    "tbl_name": "human_requests",
    "sql": "CREATE TABLE human_requests(request_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),source_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),session_id TEXT NOT NULL,question_json TEXT NOT NULL,question_digest TEXT NOT NULL,input_revision INTEGER NOT NULL DEFAULT 1,content_version INTEGER NOT NULL,safe INTEGER NOT NULL DEFAULT 0,checkpoint_ref TEXT,status TEXT NOT NULL DEFAULT 'waiting',target_json TEXT,target_conversation_id TEXT,notification_status TEXT NOT NULL DEFAULT 'pending',notification_error TEXT,response_json TEXT,response_digest TEXT,continuation_run_id TEXT UNIQUE REFERENCES runs(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL, selection_json TEXT)"
  },
  {
    "type": "table",
    "name": "human_response_messages",
    "tbl_name": "human_response_messages",
    "sql": "CREATE TABLE human_response_messages(request_id TEXT NOT NULL REFERENCES human_requests(request_id),message_id TEXT NOT NULL,actor_json TEXT NOT NULL,text TEXT NOT NULL,candidate_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(request_id,message_id))"
  },
  {
    "type": "table",
    "name": "human_response_operations",
    "tbl_name": "human_response_operations",
    "sql": "CREATE TABLE human_response_operations(operation_id TEXT PRIMARY KEY,actor_digest TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "interaction_turns",
    "tbl_name": "interaction_turns",
    "sql": "CREATE TABLE interaction_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),operation_id TEXT NOT NULL,input_ref TEXT,input_hash TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,request_ref TEXT,output_ref TEXT,error TEXT,created_at INTEGER NOT NULL,epoch INTEGER NOT NULL, queue_input_id TEXT, scope_json TEXT, reply_id TEXT,UNIQUE(conversation_id,operation_id))"
  },
  {
    "type": "table",
    "name": "invitations",
    "tbl_name": "invitations",
    "sql": "CREATE TABLE invitations (token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), inviter_member_id TEXT NOT NULL REFERENCES members(id), role TEXT NOT NULL CHECK(role IN ('admin','member')), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, used_by TEXT REFERENCES users(id), reusable INTEGER NOT NULL DEFAULT 0 CHECK(reusable IN (0,1)))"
  },
  {
    "type": "table",
    "name": "members",
    "tbl_name": "members",
    "sql": "CREATE TABLE members (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1, UNIQUE(workspace_id,user_id))"
  },
  {
    "type": "table",
    "name": "message_asset_conversation_grants",
    "tbl_name": "message_asset_conversation_grants",
    "sql": "CREATE TABLE message_asset_conversation_grants(asset_id TEXT NOT NULL REFERENCES message_assets(id) ON DELETE CASCADE,source_key TEXT NOT NULL,PRIMARY KEY(asset_id,source_key))"
  },
  {
    "type": "table",
    "name": "message_asset_links",
    "tbl_name": "message_asset_links",
    "sql": "CREATE TABLE message_asset_links(asset_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(asset_id,owner_kind,owner_id))"
  },
  {
    "type": "table",
    "name": "message_asset_run_grants",
    "tbl_name": "message_asset_run_grants",
    "sql": "CREATE TABLE message_asset_run_grants(asset_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(asset_id,run_id))"
  },
  {
    "type": "table",
    "name": "message_asset_task_selection",
    "tbl_name": "message_asset_task_selection",
    "sql": "CREATE TABLE message_asset_task_selection(task_id TEXT PRIMARY KEY,ids_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "message_asset_versions",
    "tbl_name": "message_asset_versions",
    "sql": "CREATE TABLE message_asset_versions(asset_id TEXT NOT NULL,read_kind TEXT NOT NULL,state TEXT NOT NULL,version TEXT,hash TEXT,size INTEGER,media_type TEXT,path TEXT,reason TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(asset_id,read_kind))"
  },
  {
    "type": "table",
    "name": "message_assets",
    "tbl_name": "message_assets",
    "sql": "CREATE TABLE message_assets(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,scope_json TEXT NOT NULL,descriptor_json TEXT NOT NULL,created_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "model_catalog",
    "tbl_name": "model_catalog",
    "sql": "CREATE TABLE model_catalog (\n      id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT,\n      provider TEXT NOT NULL, endpoint TEXT NOT NULL, model_id TEXT NOT NULL, secret_ref TEXT, revision INTEGER NOT NULL,\n      enabled INTEGER NOT NULL, ciphertext TEXT, nonce TEXT, tag TEXT,\n      interaction_thinking_control TEXT NOT NULL DEFAULT 'unconfigured', execution_thinking_control TEXT NOT NULL DEFAULT 'unconfigured'\n    , input_capabilities_json TEXT, protocol TEXT NOT NULL DEFAULT 'chat_completions')"
  },
  {
    "type": "table",
    "name": "model_catalog_migrations",
    "tbl_name": "model_catalog_migrations",
    "sql": "CREATE TABLE model_catalog_migrations (id TEXT PRIMARY KEY)"
  },
  {
    "type": "table",
    "name": "model_profiles",
    "tbl_name": "model_profiles",
    "sql": "CREATE TABLE model_profiles (\n      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT NOT NULL UNIQUE REFERENCES entities(id),\n      provider TEXT NOT NULL, endpoint TEXT NOT NULL, model_id TEXT NOT NULL, secret_ref TEXT, revision INTEGER NOT NULL,\n      enabled INTEGER NOT NULL, ciphertext TEXT, nonce TEXT, tag TEXT\n    , interaction_thinking_control TEXT NOT NULL DEFAULT 'unconfigured', execution_thinking_control TEXT NOT NULL DEFAULT 'unconfigured')"
  },
  {
    "type": "table",
    "name": "model_selection_epochs",
    "tbl_name": "model_selection_epochs",
    "sql": "CREATE TABLE model_selection_epochs (workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(workspace_id,entity_id))"
  },
  {
    "type": "table",
    "name": "queue_scan_cursors",
    "tbl_name": "queue_scan_cursors",
    "sql": "CREATE TABLE queue_scan_cursors(key TEXT PRIMARY KEY,epoch INTEGER NOT NULL,after_sequence INTEGER NOT NULL,ceiling INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "runs",
    "tbl_name": "runs",
    "sql": "CREATE TABLE \"runs\" (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, result TEXT, result_revision INTEGER, created_at INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, terminal_at INTEGER, history_manifest_ref TEXT, kind TEXT NOT NULL DEFAULT 'initial', parent_run_id TEXT REFERENCES runs(id), end_reason TEXT)"
  },
  {
    "type": "table",
    "name": "runtime_outputs",
    "tbl_name": "runtime_outputs",
    "sql": "CREATE TABLE runtime_outputs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),text TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "runtime_process_owner",
    "tbl_name": "runtime_process_owner",
    "sql": "CREATE TABLE runtime_process_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,instance_id TEXT NOT NULL,start_identity TEXT NOT NULL,epoch INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0)"
  },
  {
    "type": "table",
    "name": "scheduled_jobs",
    "tbl_name": "scheduled_jobs",
    "sql": "CREATE TABLE scheduled_jobs(id TEXT PRIMARY KEY,job_key TEXT UNIQUE NOT NULL,handler TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL, retention_closed_at INTEGER, retention_compacted_at INTEGER)"
  },
  {
    "type": "table",
    "name": "sessions",
    "tbl_name": "sessions",
    "sql": "CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)"
  },
  {
    "type": "table",
    "name": "skill_resource_state",
    "tbl_name": "skill_resource_state",
    "sql": "CREATE TABLE skill_resource_state(workspace_id TEXT NOT NULL,resource_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(workspace_id,resource_id))"
  },
  {
    "type": "table",
    "name": "skill_resource_versions",
    "tbl_name": "skill_resource_versions",
    "sql": "CREATE TABLE skill_resource_versions(workspace_id TEXT NOT NULL REFERENCES workspaces(id),resource_id TEXT NOT NULL,version INTEGER NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,digest TEXT NOT NULL,path TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL, package_json TEXT, source_json TEXT,PRIMARY KEY(workspace_id,resource_id,version),UNIQUE(workspace_id,operation_id),UNIQUE(workspace_id,name,version))"
  },
  {
    "type": "table",
    "name": "source_material_transfers",
    "tbl_name": "source_material_transfers",
    "sql": "CREATE TABLE source_material_transfers(\n   id TEXT NOT NULL,workspace_id TEXT NOT NULL,source_task_id TEXT NOT NULL,source_run_id TEXT NOT NULL,\n   origin_task_id TEXT NOT NULL,origin_run_id TEXT NOT NULL,target_task_id TEXT NOT NULL,target_run_id TEXT NOT NULL,\n   target_entity_id TEXT NOT NULL,intent_id TEXT NOT NULL,assignment_id TEXT NOT NULL,descriptor_json TEXT NOT NULL,\n   created_at INTEGER NOT NULL,PRIMARY KEY(id,target_run_id))"
  },
  {
    "type": "table",
    "name": "task_artifact_delivery_grants",
    "tbl_name": "task_artifact_delivery_grants",
    "sql": "CREATE TABLE task_artifact_delivery_grants(delivery_id TEXT PRIMARY KEY,scope_hash TEXT NOT NULL,target_hash TEXT NOT NULL,parent_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "task_artifact_manifests",
    "tbl_name": "task_artifact_manifests",
    "sql": "CREATE TABLE task_artifact_manifests(run_id TEXT PRIMARY KEY,refs_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "task_artifact_selection_inputs",
    "tbl_name": "task_artifact_selection_inputs",
    "sql": "CREATE TABLE task_artifact_selection_inputs(operation_id TEXT NOT NULL,turn_id TEXT NOT NULL,PRIMARY KEY(operation_id,turn_id))"
  },
  {
    "type": "table",
    "name": "task_artifact_selections",
    "tbl_name": "task_artifact_selections",
    "sql": "CREATE TABLE task_artifact_selections(operation_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,ids_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "task_completion_notifications",
    "tbl_name": "task_completion_notifications",
    "sql": "CREATE TABLE task_completion_notifications(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),scope_json TEXT NOT NULL,result_ref TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,turn_id TEXT,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,published_at INTEGER, event_status TEXT NOT NULL DEFAULT 'succeeded', delivery_id TEXT, retention_closed_at INTEGER, retention_compacted_at INTEGER,UNIQUE(task_id,run_id))"
  },
  {
    "type": "table",
    "name": "task_host_bindings",
    "tbl_name": "task_host_bindings",
    "sql": "CREATE TABLE task_host_bindings(run_id TEXT PRIMARY KEY REFERENCES runs(id),task_id TEXT NOT NULL REFERENCES tasks(id),command_json TEXT NOT NULL,profile_id TEXT NOT NULL,revision INTEGER NOT NULL,session_json TEXT,spec_json TEXT NOT NULL,host_url TEXT, binding_revision TEXT, materials_json TEXT, host_instance_id TEXT, material_pending_revision INTEGER, configuration_id TEXT, profile_source TEXT)"
  },
  {
    "type": "table",
    "name": "task_inputs",
    "tbl_name": "task_inputs",
    "sql": "CREATE TABLE task_inputs (task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, operation_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(task_id,revision), UNIQUE(task_id,operation_id))"
  },
  {
    "type": "table",
    "name": "task_operations",
    "tbl_name": "task_operations",
    "sql": "CREATE TABLE task_operations (task_id TEXT NOT NULL REFERENCES tasks(id), operation_id TEXT NOT NULL, kind TEXT NOT NULL, request_hash TEXT NOT NULL, receipt_json TEXT, PRIMARY KEY(task_id,operation_id))"
  },
  {
    "type": "table",
    "name": "task_outbox",
    "tbl_name": "task_outbox",
    "sql": "CREATE TABLE task_outbox (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), operation_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, input_revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT)"
  },
  {
    "type": "table",
    "name": "task_runtime_capabilities",
    "tbl_name": "task_runtime_capabilities",
    "sql": "CREATE TABLE task_runtime_capabilities(run_id TEXT PRIMARY KEY REFERENCES runs(id),binding_hash TEXT NOT NULL,json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "task_updates",
    "tbl_name": "task_updates",
    "sql": "CREATE TABLE task_updates (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), event_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(run_id,event_id), UNIQUE(run_id,sequence))"
  },
  {
    "type": "table",
    "name": "tasks",
    "tbl_name": "tasks",
    "sql": "CREATE TABLE \"tasks\" (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT NOT NULL REFERENCES entities(id), user_id TEXT REFERENCES users(id), conversation_id TEXT REFERENCES conversations(id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, input TEXT NOT NULL, context_mode TEXT NOT NULL, snapshot_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_expires_at INTEGER, source_json TEXT NOT NULL, config_snapshot_json TEXT, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, input_revision INTEGER NOT NULL DEFAULT 1, run_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, actor_key TEXT NOT NULL DEFAULT '', owner_key TEXT NOT NULL DEFAULT '', planned_history_ids_json TEXT NOT NULL DEFAULT '[]', planned_package_ids_json TEXT NOT NULL DEFAULT '[]', origin_kind TEXT NOT NULL DEFAULT 'conversation', trigger_id TEXT, creation_event_record_id TEXT, context_namespace TEXT, context_key TEXT, policy_revision INTEGER, terminal_at INTEGER, title TEXT, UNIQUE(user_id,entity_id,conversation_id,operation_id))"
  },
  {
    "type": "table",
    "name": "trigger_bindings",
    "tbl_name": "trigger_bindings",
    "sql": "CREATE TABLE trigger_bindings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),type TEXT NOT NULL CHECK(type IN ('webhook','schedule')),name TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),version INTEGER NOT NULL,allowed_actions_json TEXT NOT NULL,config_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "trigger_context_grants",
    "tbl_name": "trigger_context_grants",
    "sql": "CREATE TABLE trigger_context_grants(run_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,credential TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,endpoint TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "trigger_context_queries",
    "tbl_name": "trigger_context_queries",
    "sql": "CREATE TABLE trigger_context_queries(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,scope_digest TEXT NOT NULL,after_time INTEGER NOT NULL,after_id TEXT NOT NULL,limit_count INTEGER NOT NULL,result_ref TEXT)"
  },
  {
    "type": "table",
    "name": "trigger_context_resources",
    "tbl_name": "trigger_context_resources",
    "sql": "CREATE TABLE trigger_context_resources(id TEXT PRIMARY KEY,target_task_id TEXT NOT NULL,source_task_id TEXT NOT NULL,source_run_id TEXT NOT NULL,kind TEXT NOT NULL,metadata_json TEXT NOT NULL,UNIQUE(target_task_id,source_run_id,kind,metadata_json))"
  },
  {
    "type": "table",
    "name": "trigger_context_scopes",
    "tbl_name": "trigger_context_scopes",
    "sql": "CREATE TABLE trigger_context_scopes(task_id TEXT PRIMARY KEY,scope_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "trigger_credentials",
    "tbl_name": "trigger_credentials",
    "sql": "CREATE TABLE trigger_credentials(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES trigger_bindings(id),key_id TEXT NOT NULL,credential_version INTEGER NOT NULL,ciphertext TEXT NOT NULL,nonce TEXT NOT NULL,tag TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('active','revoked')),created_at INTEGER NOT NULL,revoked_at INTEGER,UNIQUE(trigger_id,key_id))"
  },
  {
    "type": "table",
    "name": "trigger_events",
    "tbl_name": "trigger_events",
    "sql": "CREATE TABLE trigger_events(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES trigger_bindings(id),event_id TEXT NOT NULL,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_evidence_ref TEXT NOT NULL,binding_version INTEGER NOT NULL,action TEXT NOT NULL,payload_json TEXT NOT NULL,body_hash TEXT NOT NULL,scheduled_at INTEGER,context_namespace TEXT,context_key TEXT,policy_revision INTEGER,task_id TEXT,command_operation_id TEXT,status TEXT NOT NULL,receipt_json TEXT,error_code TEXT,received_at INTEGER NOT NULL,processed_at INTEGER,UNIQUE(trigger_id,event_id))"
  },
  {
    "type": "table",
    "name": "trigger_notification_targets",
    "tbl_name": "trigger_notification_targets",
    "sql": "CREATE TABLE trigger_notification_targets(task_id TEXT PRIMARY KEY REFERENCES tasks(id),targets_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "trigger_result_notifications",
    "tbl_name": "trigger_result_notifications",
    "sql": "CREATE TABLE trigger_result_notifications(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id),target_key TEXT NOT NULL,target_json TEXT NOT NULL,label TEXT NOT NULL,scope_json TEXT NOT NULL,text TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,delivery_status TEXT NOT NULL DEFAULT 'pending',delivery_error TEXT,provider_accepted INTEGER NOT NULL DEFAULT 0,UNIQUE(task_id,run_id,target_key))"
  },
  {
    "type": "table",
    "name": "users",
    "tbl_name": "users",
    "sql": "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')"
  },
  {
    "type": "table",
    "name": "web_conversation_previews",
    "tbl_name": "web_conversation_previews",
    "sql": "CREATE TABLE web_conversation_previews(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,message_id TEXT NOT NULL,message_rowid INTEGER NOT NULL,excerpt TEXT NOT NULL CHECK(length(excerpt)<=160),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "web_private_conversations",
    "tbl_name": "web_private_conversations",
    "sql": "CREATE TABLE web_private_conversations(workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),owner_key TEXT NOT NULL,conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),PRIMARY KEY(workspace_id,entity_id,owner_key))"
  },
  {
    "type": "table",
    "name": "wecom_bot_contacts",
    "tbl_name": "wecom_bot_contacts",
    "sql": "CREATE TABLE wecom_bot_contacts (\n      connection_id TEXT NOT NULL, source_id TEXT NOT NULL, auth_revision INTEGER NOT NULL,\n      user_id TEXT NOT NULL, display_name TEXT NOT NULL, department_paths TEXT NOT NULL,\n      found_at INTEGER NOT NULL, selected INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(connection_id,source_id,auth_revision,user_id)\n    )"
  },
  {
    "type": "table",
    "name": "wecom_identity_bindings",
    "tbl_name": "wecom_identity_bindings",
    "sql": "CREATE TABLE wecom_identity_bindings(connection_id TEXT NOT NULL,source_id TEXT NOT NULL,auth_revision INTEGER NOT NULL,user_id TEXT NOT NULL,callback_user_id TEXT NOT NULL,mapping_json TEXT,PRIMARY KEY(connection_id,source_id,auth_revision,user_id),UNIQUE(connection_id,source_id,auth_revision,callback_user_id))"
  },
  {
    "type": "table",
    "name": "wecom_member_challenges",
    "tbl_name": "wecom_member_challenges",
    "sql": "CREATE TABLE wecom_member_challenges(connection_id TEXT NOT NULL,source_id TEXT NOT NULL,auth_revision INTEGER NOT NULL,request_id TEXT NOT NULL,user_id TEXT NOT NULL,phrase_hash TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,retired_at INTEGER NOT NULL,challenge_json TEXT NOT NULL,PRIMARY KEY(connection_id,source_id,auth_revision,request_id),UNIQUE(connection_id,source_id,auth_revision,phrase_hash))"
  },
  {
    "type": "table",
    "name": "wecom_member_verification_requests",
    "tbl_name": "wecom_member_verification_requests",
    "sql": "CREATE TABLE wecom_member_verification_requests(connection_id TEXT NOT NULL,source_id TEXT NOT NULL,auth_revision INTEGER NOT NULL,request_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,app_id TEXT NOT NULL,code_hash TEXT,collision_hash TEXT,sealed_code TEXT,issued_request_id TEXT NOT NULL,PRIMARY KEY(connection_id,source_id,auth_revision,request_id),UNIQUE(collision_hash))"
  },
  {
    "type": "table",
    "name": "work_item_artifact_materials",
    "tbl_name": "work_item_artifact_materials",
    "sql": "CREATE TABLE work_item_artifact_materials(\n      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_task_id TEXT NOT NULL,source_run_id TEXT NOT NULL,\n      source_entity_id TEXT NOT NULL,resource_id TEXT NOT NULL,version TEXT NOT NULL,artifact_json TEXT NOT NULL,\n      UNIQUE(workspace_id,source_run_id,resource_id,version))"
  },
  {
    "type": "table",
    "name": "work_item_assignment_roles",
    "tbl_name": "work_item_assignment_roles",
    "sql": "CREATE TABLE work_item_assignment_roles(assignment_id TEXT PRIMARY KEY,kind TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_item_assignments",
    "tbl_name": "work_item_assignments",
    "sql": "CREATE TABLE work_item_assignments(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,employee_id TEXT NOT NULL,source_employee_id TEXT NOT NULL,previous_id TEXT,grant_id TEXT NOT NULL UNIQUE,snapshot_json TEXT NOT NULL,summary TEXT NOT NULL,created_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_item_beta_state",
    "tbl_name": "work_item_beta_state",
    "sql": "CREATE TABLE work_item_beta_state(workspace_id TEXT PRIMARY KEY,observed_revision INTEGER NOT NULL,applied_revision INTEGER NOT NULL,enabled INTEGER NOT NULL,error TEXT)"
  },
  {
    "type": "table",
    "name": "work_item_dispatches",
    "tbl_name": "work_item_dispatches",
    "sql": "CREATE TABLE work_item_dispatches(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,assignment_id TEXT NOT NULL,source_task_id TEXT NOT NULL,task_id TEXT,state TEXT NOT NULL,error TEXT, source_run_id TEXT)"
  },
  {
    "type": "table",
    "name": "work_item_events",
    "tbl_name": "work_item_events",
    "sql": "CREATE TABLE work_item_events(id INTEGER PRIMARY KEY AUTOINCREMENT,work_item_id TEXT NOT NULL,assignment_id TEXT NOT NULL,kind TEXT NOT NULL,body_json TEXT NOT NULL,created_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_item_intents",
    "tbl_name": "work_item_intents",
    "sql": "CREATE TABLE work_item_intents(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,operation_id TEXT NOT NULL,work_item_id TEXT NOT NULL,assignment_id TEXT NOT NULL,expected_version INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,prepared_json TEXT NOT NULL,checkpoint_ref TEXT,UNIQUE(task_id,operation_id))"
  },
  {
    "type": "table",
    "name": "work_item_notification_cursor",
    "tbl_name": "work_item_notification_cursor",
    "sql": "CREATE TABLE work_item_notification_cursor(id INTEGER PRIMARY KEY CHECK(id=1),after_id INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_item_notifications",
    "tbl_name": "work_item_notifications",
    "sql": "CREATE TABLE work_item_notifications(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,event_id INTEGER NOT NULL,milestone TEXT NOT NULL,target_key TEXT NOT NULL,scope_json TEXT NOT NULL,target_json TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,UNIQUE(work_item_id,milestone,target_key))"
  },
  {
    "type": "table",
    "name": "work_item_operations",
    "tbl_name": "work_item_operations",
    "sql": "CREATE TABLE work_item_operations(task_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(task_id,operation_id))"
  },
  {
    "type": "table",
    "name": "work_item_resource_transfers",
    "tbl_name": "work_item_resource_transfers",
    "sql": "CREATE TABLE work_item_resource_transfers(target_task_id TEXT PRIMARY KEY,source_task_id TEXT NOT NULL,source_run_id TEXT NOT NULL,intent_id TEXT NOT NULL,assignment_id TEXT NOT NULL,fingerprint TEXT NOT NULL,package_digest TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_item_task_links",
    "tbl_name": "work_item_task_links",
    "sql": "CREATE TABLE work_item_task_links(task_id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,assignment_id TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_item_task_tool_snapshots",
    "tbl_name": "work_item_task_tool_snapshots",
    "sql": "CREATE TABLE work_item_task_tool_snapshots(task_id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_item_tool_grants",
    "tbl_name": "work_item_tool_grants",
    "sql": "CREATE TABLE work_item_tool_grants(run_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,credential TEXT NOT NULL,endpoint TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "work_items",
    "tbl_name": "work_items",
    "sql": "CREATE TABLE work_items(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,root_task_id TEXT NOT NULL,root_scope_json TEXT NOT NULL,projection_json TEXT NOT NULL)"
  },
  {
    "type": "table",
    "name": "workspace_mcp_state",
    "tbl_name": "workspace_mcp_state",
    "sql": "CREATE TABLE workspace_mcp_state(workspace_id TEXT NOT NULL,resource_id TEXT NOT NULL,version INTEGER NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(workspace_id,resource_id))"
  },
  {
    "type": "table",
    "name": "workspace_mcp_versions",
    "tbl_name": "workspace_mcp_versions",
    "sql": "CREATE TABLE workspace_mcp_versions(workspace_id TEXT NOT NULL,resource_id TEXT NOT NULL,version INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(workspace_id,resource_id,version))"
  },
  {
    "type": "table",
    "name": "workspace_model_defaults",
    "tbl_name": "workspace_model_defaults",
    "sql": "CREATE TABLE workspace_model_defaults (\n      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), profile_id TEXT NOT NULL REFERENCES model_catalog(id)\n    )"
  },
  {
    "type": "table",
    "name": "workspace_work_item_settings",
    "tbl_name": "workspace_work_item_settings",
    "sql": "CREATE TABLE workspace_work_item_settings(workspace_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)))"
  },
  {
    "type": "table",
    "name": "workspaces",
    "tbl_name": "workspaces",
    "sql": "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active')"
  },
  {
    "type": "index",
    "name": "builtin_journal_execution",
    "tbl_name": "builtin_journal_index",
    "sql": "CREATE INDEX builtin_journal_execution ON builtin_journal_index(resource_id,execution_key,kind)"
  },
  {
    "type": "index",
    "name": "builtin_journal_kind",
    "tbl_name": "builtin_journal_index",
    "sql": "CREATE INDEX builtin_journal_kind ON builtin_journal_index(resource_id,kind,sequence)"
  },
  {
    "type": "index",
    "name": "builtin_operation_retention",
    "tbl_name": "builtin_operations",
    "sql": "CREATE INDEX builtin_operation_retention ON builtin_operations(closed_at)"
  },
  {
    "type": "index",
    "name": "builtin_record_retention",
    "tbl_name": "builtin_records",
    "sql": "CREATE INDEX builtin_record_retention ON builtin_records(closed_at)"
  },
  {
    "type": "trigger",
    "name": "business_notice_receipt_insert",
    "tbl_name": "channel_message_receipts",
    "sql": "CREATE TRIGGER business_notice_receipt_insert AFTER INSERT ON channel_message_receipts WHEN NEW.kind='outbox' BEGIN UPDATE business_notification_jobs SET delivery_state=NEW.status,delivery_error=NEW.error WHERE id=NEW.id;END"
  },
  {
    "type": "trigger",
    "name": "business_notice_receipt_update",
    "tbl_name": "channel_message_receipts",
    "sql": "CREATE TRIGGER business_notice_receipt_update AFTER UPDATE ON channel_message_receipts WHEN NEW.kind='outbox' BEGIN UPDATE business_notification_jobs SET delivery_state=NEW.status,delivery_error=NEW.error WHERE id=NEW.id;END"
  },
  {
    "type": "index",
    "name": "business_notification_pending",
    "tbl_name": "business_notification_jobs",
    "sql": "CREATE INDEX business_notification_pending ON business_notification_jobs(state,retry_at)"
  },
  {
    "type": "index",
    "name": "business_notification_source",
    "tbl_name": "business_notification_jobs",
    "sql": "CREATE INDEX business_notification_source ON business_notification_jobs(source_kind,source_id)"
  },
  {
    "type": "index",
    "name": "channel_delivery_claim",
    "tbl_name": "channel_deliveries",
    "sql": "CREATE INDEX channel_delivery_claim ON channel_deliveries(status,retry_at,blocking)"
  },
  {
    "type": "index",
    "name": "channel_delivery_receipt_query",
    "tbl_name": "channel_deliveries",
    "sql": "CREATE INDEX channel_delivery_receipt_query ON channel_deliveries(receipt_query_state,receipt_query_at)"
  },
  {
    "type": "index",
    "name": "channel_delivery_retention",
    "tbl_name": "channel_deliveries",
    "sql": "CREATE INDEX channel_delivery_retention ON channel_deliveries(closed_at,status)"
  },
  {
    "type": "index",
    "name": "channel_discovered_groups_membership",
    "tbl_name": "channel_discovered_groups",
    "sql": "CREATE INDEX channel_discovered_groups_membership ON channel_discovered_groups(connection_id,chat_id)"
  },
  {
    "type": "index",
    "name": "channel_discovered_groups_page",
    "tbl_name": "channel_discovered_groups",
    "sql": "CREATE INDEX channel_discovered_groups_page ON channel_discovered_groups(workspace_id,entity_id,connection_id,app_id,tenant_id,binding_version,last_message_at DESC,id DESC)"
  },
  {
    "type": "index",
    "name": "channel_inbox_claim",
    "tbl_name": "channel_inbox",
    "sql": "CREATE INDEX channel_inbox_claim ON channel_inbox(status,retry_at,lease_until)"
  },
  {
    "type": "index",
    "name": "channel_inbox_history_batch",
    "tbl_name": "channel_inbox",
    "sql": "CREATE INDEX channel_inbox_history_batch ON channel_inbox(history_batch_id)"
  },
  {
    "type": "index",
    "name": "channel_inbox_order",
    "tbl_name": "channel_inbox",
    "sql": "CREATE INDEX channel_inbox_order ON channel_inbox(lane,created_at,id)"
  },
  {
    "type": "index",
    "name": "channel_inbox_retention",
    "tbl_name": "channel_inbox",
    "sql": "CREATE INDEX channel_inbox_retention ON channel_inbox(closed_at,status,rt_terminal)"
  },
  {
    "type": "index",
    "name": "channel_inbox_source_identity",
    "tbl_name": "channel_inbox",
    "sql": "CREATE INDEX channel_inbox_source_identity ON channel_inbox(source_key)"
  },
  {
    "type": "index",
    "name": "channel_receipt_retention",
    "tbl_name": "channel_message_receipts",
    "sql": "CREATE INDEX channel_receipt_retention ON channel_message_receipts(updated_at,status)"
  },
  {
    "type": "index",
    "name": "channel_receipt_source_identity",
    "tbl_name": "channel_message_receipts",
    "sql": "CREATE INDEX channel_receipt_source_identity ON channel_message_receipts(source_key,kind)"
  },
  {
    "type": "index",
    "name": "channel_state_report_pending",
    "tbl_name": "channel_state_reports",
    "sql": "CREATE INDEX channel_state_report_pending ON channel_state_reports(status,sequence)"
  },
  {
    "type": "index",
    "name": "conversations_principal_operation",
    "tbl_name": "conversations",
    "sql": "CREATE UNIQUE INDEX conversations_principal_operation ON conversations(workspace_id,entity_id,owner_key,operation_id)"
  },
  {
    "type": "index",
    "name": "directory_alias_person",
    "tbl_name": "directory_snapshot_aliases",
    "sql": "CREATE INDEX directory_alias_person ON directory_snapshot_aliases(task_id,person_namespace,person_id)"
  },
  {
    "type": "index",
    "name": "directory_membership_department",
    "tbl_name": "directory_snapshot_memberships",
    "sql": "CREATE INDEX directory_membership_department ON directory_snapshot_memberships(task_id,department_id,namespace,external_id)"
  },
  {
    "type": "index",
    "name": "directory_search_name",
    "tbl_name": "directory_snapshot_search",
    "sql": "CREATE INDEX directory_search_name ON directory_snapshot_search(task_id,kind,search_name,namespace,external_id)"
  },
  {
    "type": "index",
    "name": "directory_search_parent",
    "tbl_name": "directory_snapshot_search",
    "sql": "CREATE INDEX directory_search_parent ON directory_snapshot_search(task_id,kind,parent_id,search_name,external_id)"
  },
  {
    "type": "index",
    "name": "directory_sync_due",
    "tbl_name": "directory_sync_tasks",
    "sql": "CREATE INDEX directory_sync_due ON directory_sync_tasks(enabled,next_at)"
  },
  {
    "type": "index",
    "name": "directory_sync_history_page",
    "tbl_name": "directory_sync_history",
    "sql": "CREATE INDEX directory_sync_history_page ON directory_sync_history(task_id,started_at,id)"
  },
  {
    "type": "index",
    "name": "employee_channel_global_app",
    "tbl_name": "employee_channel_connections",
    "sql": "CREATE UNIQUE INDEX employee_channel_global_app ON employee_channel_connections(provider,app_id)"
  },
  {
    "type": "index",
    "name": "employee_channel_global_bot",
    "tbl_name": "employee_channel_connections",
    "sql": "CREATE UNIQUE INDEX employee_channel_global_bot ON employee_channel_connections(provider,(CASE WHEN provider='dingtalk' AND length(json_extract(record_json,'$.robotCode'))>0 THEN 'robot:'||json_extract(record_json,'$.robotCode') ELSE 'app:'||app_id END))"
  },
  {
    "type": "index",
    "name": "feishu_group_evidence_pending",
    "tbl_name": "feishu_group_evidence",
    "sql": "CREATE INDEX feishu_group_evidence_pending ON feishu_group_evidence(status,retry_at)"
  },
  {
    "type": "index",
    "name": "group_batch_released_retention",
    "tbl_name": "group_live_batches",
    "sql": "CREATE INDEX group_batch_released_retention ON group_live_batches(released,retention_closed_at,id)"
  },
  {
    "type": "index",
    "name": "group_batch_released_scan",
    "tbl_name": "group_live_batches",
    "sql": "CREATE INDEX group_batch_released_scan ON group_live_batches(released)"
  },
  {
    "type": "index",
    "name": "group_batch_scope_released",
    "tbl_name": "group_live_batches",
    "sql": "CREATE INDEX group_batch_scope_released ON group_live_batches(scope,released,id)"
  },
  {
    "type": "index",
    "name": "group_batch_status_released",
    "tbl_name": "group_live_batches",
    "sql": "CREATE INDEX group_batch_status_released ON group_live_batches(status,released,id)"
  },
  {
    "type": "index",
    "name": "group_live_batch_ref",
    "tbl_name": "group_live_messages",
    "sql": "CREATE INDEX group_live_batch_ref ON group_live_messages(batch_id)"
  },
  {
    "type": "index",
    "name": "group_live_batches_technical_retention",
    "tbl_name": "group_live_batches",
    "sql": "CREATE INDEX group_live_batches_technical_retention ON group_live_batches(retention_closed_at,retention_compacted_at)"
  },
  {
    "type": "index",
    "name": "group_live_connection_chat",
    "tbl_name": "group_live_messages",
    "sql": "CREATE INDEX group_live_connection_chat ON group_live_messages(connection_id,chat_id,sequence)"
  },
  {
    "type": "index",
    "name": "group_live_connection_sequence",
    "tbl_name": "group_live_messages",
    "sql": "CREATE INDEX group_live_connection_sequence ON group_live_messages(connection_id,sequence)"
  },
  {
    "type": "index",
    "name": "group_live_family",
    "tbl_name": "group_live_messages",
    "sql": "CREATE INDEX group_live_family ON group_live_messages(family,scope)"
  },
  {
    "type": "index",
    "name": "group_live_window",
    "tbl_name": "group_live_messages",
    "sql": "CREATE INDEX group_live_window ON group_live_messages(scope,occurred_at,sequence)"
  },
  {
    "type": "index",
    "name": "group_root_connection",
    "tbl_name": "group_live_topic_roots",
    "sql": "CREATE INDEX group_root_connection ON group_live_topic_roots(connection_id)"
  },
  {
    "type": "index",
    "name": "group_root_connection_chat",
    "tbl_name": "group_live_topic_roots",
    "sql": "CREATE INDEX group_root_connection_chat ON group_live_topic_roots(connection_id,chat_id)"
  },
  {
    "type": "index",
    "name": "group_root_family",
    "tbl_name": "group_live_topic_roots",
    "sql": "CREATE INDEX group_root_family ON group_live_topic_roots(family,scope)"
  },
  {
    "type": "index",
    "name": "message_asset_created",
    "tbl_name": "message_assets",
    "sql": "CREATE INDEX message_asset_created ON message_assets(created_at)"
  },
  {
    "type": "index",
    "name": "recent_web_messages",
    "tbl_name": "conversation_message_index",
    "sql": "CREATE INDEX recent_web_messages ON conversation_message_index(conversation_id,created_at,id)"
  },
  {
    "type": "index",
    "name": "recent_web_owner",
    "tbl_name": "conversations",
    "sql": "CREATE INDEX recent_web_owner ON conversations(workspace_id,owner_key,channel,entity_id,created_at,id)"
  },
  {
    "type": "index",
    "name": "runs_session_segments",
    "tbl_name": "runs",
    "sql": "CREATE INDEX runs_session_segments ON runs(session_id,created_at,id)"
  },
  {
    "type": "index",
    "name": "runs_task_attempt",
    "tbl_name": "runs",
    "sql": "CREATE UNIQUE INDEX runs_task_attempt ON runs(task_id,attempt)"
  },
  {
    "type": "index",
    "name": "scheduled_jobs_due",
    "tbl_name": "scheduled_jobs",
    "sql": "CREATE INDEX scheduled_jobs_due ON scheduled_jobs(status,retry_at,lease_until)"
  },
  {
    "type": "index",
    "name": "scheduled_jobs_technical_retention",
    "tbl_name": "scheduled_jobs",
    "sql": "CREATE INDEX scheduled_jobs_technical_retention ON scheduled_jobs(retention_closed_at,retention_compacted_at)"
  },
  {
    "type": "index",
    "name": "source_material_transfer_target",
    "tbl_name": "source_material_transfers",
    "sql": "CREATE INDEX source_material_transfer_target ON source_material_transfers(target_run_id,target_task_id)"
  },
  {
    "type": "index",
    "name": "task_completion_delivery",
    "tbl_name": "task_completion_notifications",
    "sql": "CREATE UNIQUE INDEX task_completion_delivery ON task_completion_notifications(delivery_id)"
  },
  {
    "type": "index",
    "name": "task_completion_notifications_technical_retention",
    "tbl_name": "task_completion_notifications",
    "sql": "CREATE INDEX task_completion_notifications_technical_retention ON task_completion_notifications(retention_closed_at,retention_compacted_at)"
  },
  {
    "type": "index",
    "name": "task_completion_pending",
    "tbl_name": "task_completion_notifications",
    "sql": "CREATE INDEX task_completion_pending ON task_completion_notifications(status,retry_at)"
  },
  {
    "type": "index",
    "name": "task_outbox_input_predecessor",
    "tbl_name": "task_outbox",
    "sql": "CREATE INDEX task_outbox_input_predecessor ON task_outbox(run_id,kind,input_revision,status)"
  },
  {
    "type": "index",
    "name": "task_outbox_pending_kind",
    "tbl_name": "task_outbox",
    "sql": "CREATE INDEX task_outbox_pending_kind ON task_outbox(kind,status,retry_at)"
  },
  {
    "type": "index",
    "name": "tasks_conversation_page",
    "tbl_name": "tasks",
    "sql": "CREATE INDEX tasks_conversation_page ON tasks(workspace_id,entity_id,actor_key,owner_key,conversation_id,created_at DESC,id DESC)"
  },
  {
    "type": "index",
    "name": "tasks_principal_operation",
    "tbl_name": "tasks",
    "sql": "CREATE UNIQUE INDEX tasks_principal_operation ON tasks(workspace_id,entity_id,actor_key,owner_key,conversation_id,operation_id)"
  },
  {
    "type": "index",
    "name": "tasks_trigger_creation_event",
    "tbl_name": "tasks",
    "sql": "CREATE UNIQUE INDEX tasks_trigger_creation_event ON tasks(creation_event_record_id) WHERE creation_event_record_id IS NOT NULL"
  },
  {
    "type": "index",
    "name": "tasks_trigger_history",
    "tbl_name": "tasks",
    "sql": "CREATE INDEX tasks_trigger_history ON tasks(workspace_id,entity_id,origin_kind,context_namespace,context_key,terminal_at,id)"
  },
  {
    "type": "index",
    "name": "tasks_trigger_operation",
    "tbl_name": "tasks",
    "sql": "CREATE UNIQUE INDEX tasks_trigger_operation ON tasks(workspace_id,entity_id,actor_key,owner_key,operation_id) WHERE origin_kind='trigger'"
  },
  {
    "type": "index",
    "name": "trigger_bindings_employee",
    "tbl_name": "trigger_bindings",
    "sql": "CREATE INDEX trigger_bindings_employee ON trigger_bindings(workspace_id,entity_id,id)"
  },
  {
    "type": "index",
    "name": "trigger_credentials_active",
    "tbl_name": "trigger_credentials",
    "sql": "CREATE INDEX trigger_credentials_active ON trigger_credentials(trigger_id,status)"
  },
  {
    "type": "index",
    "name": "trigger_events_recovery",
    "tbl_name": "trigger_events",
    "sql": "CREATE INDEX trigger_events_recovery ON trigger_events(status,received_at,id)"
  },
  {
    "type": "index",
    "name": "trigger_events_task",
    "tbl_name": "trigger_events",
    "sql": "CREATE INDEX trigger_events_task ON trigger_events(task_id,received_at,id)"
  },
  {
    "type": "trigger",
    "name": "trigger_result_receipt_insert",
    "tbl_name": "channel_message_receipts",
    "sql": "CREATE TRIGGER trigger_result_receipt_insert AFTER INSERT ON channel_message_receipts WHEN NEW.kind='outbox' AND NEW.id GLOB 'trigger-result:*' BEGIN UPDATE trigger_result_notifications SET delivery_status=NEW.status,delivery_error=NEW.error,provider_accepted=(NEW.provider_request_id IS NOT NULL) WHERE id=NEW.id;END"
  },
  {
    "type": "trigger",
    "name": "trigger_result_receipt_update",
    "tbl_name": "channel_message_receipts",
    "sql": "CREATE TRIGGER trigger_result_receipt_update AFTER UPDATE ON channel_message_receipts WHEN NEW.kind='outbox' AND NEW.id GLOB 'trigger-result:*' BEGIN UPDATE trigger_result_notifications SET delivery_status=NEW.status,delivery_error=NEW.error,provider_accepted=(NEW.provider_request_id IS NOT NULL) WHERE id=NEW.id;END"
  },
  {
    "type": "index",
    "name": "trigger_results_task",
    "tbl_name": "trigger_result_notifications",
    "sql": "CREATE INDEX trigger_results_task ON trigger_result_notifications(task_id,run_id)"
  },
  {
    "type": "index",
    "name": "wecom_challenge_retirement",
    "tbl_name": "wecom_member_challenges",
    "sql": "CREATE INDEX wecom_challenge_retirement ON wecom_member_challenges(retired_at)"
  },
  {
    "type": "index",
    "name": "wecom_challenge_user",
    "tbl_name": "wecom_member_challenges",
    "sql": "CREATE INDEX wecom_challenge_user ON wecom_member_challenges(connection_id,source_id,auth_revision,user_id)"
  },
  {
    "type": "index",
    "name": "work_item_dispatch_item",
    "tbl_name": "work_item_dispatches",
    "sql": "CREATE INDEX work_item_dispatch_item ON work_item_dispatches(work_item_id,state)"
  },
  {
    "type": "index",
    "name": "work_item_dispatch_ready",
    "tbl_name": "work_item_dispatches",
    "sql": "CREATE INDEX work_item_dispatch_ready ON work_item_dispatches(state)"
  },
  {
    "type": "index",
    "name": "work_item_intent_ready",
    "tbl_name": "work_item_intents",
    "sql": "CREATE INDEX work_item_intent_ready ON work_item_intents(state)"
  },
  {
    "type": "index",
    "name": "workbench_connection_employee_provider",
    "tbl_name": "employee_channel_connections",
    "sql": "CREATE INDEX workbench_connection_employee_provider ON employee_channel_connections(workspace_id,entity_id,provider)"
  },
  {
    "type": "index",
    "name": "workbench_connections_order",
    "tbl_name": "employee_channel_connections",
    "sql": "CREATE INDEX workbench_connections_order ON employee_channel_connections(workspace_id,id)"
  },
  {
    "type": "index",
    "name": "workbench_employee_order",
    "tbl_name": "entities",
    "sql": "CREATE INDEX workbench_employee_order ON entities(workspace_id,id)"
  },
  {
    "type": "index",
    "name": "workbench_package_employee",
    "tbl_name": "capability_packages",
    "sql": "CREATE INDEX workbench_package_employee ON capability_packages(workspace_id,entity_id)"
  },
  {
    "type": "index",
    "name": "workbench_tasks_entity_order",
    "tbl_name": "tasks",
    "sql": "CREATE INDEX workbench_tasks_entity_order ON tasks(workspace_id,entity_id,created_at DESC,id DESC)"
  },
  {
    "type": "index",
    "name": "workbench_tasks_order",
    "tbl_name": "tasks",
    "sql": "CREATE INDEX workbench_tasks_order ON tasks(workspace_id,created_at DESC,id DESC)"
  }
] as const;
