/** Recognized retired structures may remain in an existing database. These are
 * validation signatures only: never create, copy into TEMP, or delete them. */
export const RETAINED_LEGACY_SCHEMA = [
 {type:'table',name:'employee_channel_directory_credentials',owner:'platform',sql:'CREATE TABLE employee_channel_directory_credentials(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),provider TEXT NOT NULL,corp_id TEXT NOT NULL,agent_id TEXT NOT NULL,state_version INTEGER NOT NULL,record_json TEXT NOT NULL,UNIQUE(workspace_id,provider,corp_id,agent_id))'},
 {type:'index',name:'employee_channel_directory_reference',owner:'platform',sql:'CREATE INDEX employee_channel_directory_reference ON employee_channel_connections(directory_credential_id)'},
 {type:'table',name:'wecom_member_verification_attempts',owner:'runtime',sql:'CREATE TABLE wecom_member_verification_attempts(bot_id TEXT NOT NULL,epoch TEXT NOT NULL,message_id TEXT NOT NULL,callback_id TEXT NOT NULL,created_at INTEGER NOT NULL,failed INTEGER NOT NULL,PRIMARY KEY(bot_id,epoch,message_id))'},
 {type:'table',name:'wecom_member_verification_notices',owner:'runtime',sql:'CREATE TABLE wecom_member_verification_notices(bot_id TEXT NOT NULL,epoch TEXT NOT NULL,callback_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,epoch,callback_id))'},
] as const;
export const RETAINED_DIRECTORY_COLUMN='directory_credential_id TEXT REFERENCES employee_channel_directory_credentials(id) ON DELETE RESTRICT';
