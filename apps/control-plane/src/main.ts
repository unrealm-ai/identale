import {defaultDatabasePath, defaultSkillResourceRoot, expandHomePath} from './storage-config.js';
import type { ApprovedResource } from './capability-config.js';
import {createPlatformServer} from './split/server.js';
import {Store,LegacyConversationStorageError} from './store.js';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {BuiltinTestContextResetRequiredError}from'./adapters/sqlite/builtin-stores.js';

// Read-only legacy diagnostics precede deployment credential validation. Never open
// an old all-in-one database with the split platform writer merely to diagnose it.
const databasePath=expandHomePath(process.env['DENTITY_DATABASE_PATH']??defaultDatabasePath('platform'));
try{
  Store.preflight(databasePath);
  if(existsSync(databasePath)){
    const db=new DatabaseSync(databasePath,{readOnly:true});
    try{if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='builtin_records' AND type='table'").get()&&db.prepare("SELECT key FROM builtin_records WHERE key LIKE 'builtin:session:%' AND json_extract(json,'$.closed')=0 AND json_extract(json,'$.supersededBy') IS NULL AND json_extract(json,'$.handle.scope.kind')='interaction' AND json_extract(json,'$.handle.sessionId')!=json_extract(json,'$.handle.scope.conversationId') LIMIT 1").get())throw new BuiltinTestContextResetRequiredError();}
    finally{db.close();}
  }
}catch(error){console.error(error instanceof LegacyConversationStorageError||error instanceof BuiltinTestContextResetRequiredError?error.message:'Unable to read configured platform storage safely.');process.exit(1);}
const rawPort = process.env['DENTITY_CONTROL_PLANE_PORT'] ?? '18300';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('DENTITY_CONTROL_PLANE_PORT must be an integer between 1 and 65535');
}
const rawMasterKey = process.env['DENTITY_MODEL_MASTER_KEY'];
const masterKey = rawMasterKey ? Buffer.from(rawMasterKey, 'base64') : undefined;
if (masterKey && (masterKey.length !== 32 || masterKey.toString('base64') !== rawMasterKey)) throw new Error('DENTITY_MODEL_MASTER_KEY must encode exactly 32 bytes in canonical base64');
const hostUrl = process.env['DENTITY_RUNTIME_HOST_URL'];
let approvedResources: readonly ApprovedResource[] = [];
if (process.env['DENTITY_APPROVED_RESOURCES_JSON']) {
  try { const parsed: unknown = JSON.parse(process.env['DENTITY_APPROVED_RESOURCES_JSON']); if (!Array.isArray(parsed)) throw new Error(); approvedResources = parsed as ApprovedResource[]; }
  catch { throw new Error('DENTITY_APPROVED_RESOURCES_JSON must be a valid approved-resource array'); }
}
const configurationToken=process.env['DENTITY_PLATFORM_CONFIG_TOKEN'];
const runtimeServiceUrl=process.env['DENTITY_RUNTIME_SERVICE_URL'];
const runtimeServiceToken=process.env['DENTITY_RUNTIME_SERVICE_TOKEN'];
if(!configurationToken||!runtimeServiceUrl||!runtimeServiceToken)throw new Error('Platform requires runtime service and configuration synchronization credentials');
const monitorToken=process.env['DENTITY_PI_MONITOR_TOKEN'];
const server = createPlatformServer({
  configurationToken,
  runtimeService:{url:runtimeServiceUrl,token:runtimeServiceToken},
  ...(hostUrl&&monitorToken?{piMonitor:{url:hostUrl,token:monitorToken}}:{}),
  approvedResources,
  triggers:{allowLoopbackHttp:process.env['DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP']==='true'},
  mcpResources:{allowedOrigins:(process.env['DENTITY_MCP_ALLOWED_ORIGINS']??'').split(',').filter(Boolean),allowLoopbackHttp:process.env['DENTITY_MODEL_ALLOW_LOOPBACK_HTTP']==='true'},
  skillResourceRoot:expandHomePath(process.env['DENTITY_SKILL_RESOURCE_ROOT']??defaultSkillResourceRoot()),
  maintenance:{enabled:process.env['DENTITY_MAINTENANCE_ENABLED']!=='false',...(process.env['DENTITY_MAINTENANCE_INTERVAL_MS']?{intervalMs:Number(process.env['DENTITY_MAINTENANCE_INTERVAL_MS'])}:{}),policy:{...(process.env['DENTITY_CONTEXT_RETAIN_MESSAGES']?{retainMessages:Number(process.env['DENTITY_CONTEXT_RETAIN_MESSAGES'])}:{}),...(process.env['DENTITY_CONTEXT_TOKEN_THRESHOLD']?{contextTokenThreshold:Number(process.env['DENTITY_CONTEXT_TOKEN_THRESHOLD'])}:{}),...(process.env['DENTITY_SUMMARY_TIMEZONE']?{timezone:process.env['DENTITY_SUMMARY_TIMEZONE']}:{}),...(process.env['DENTITY_SUMMARY_RECENT_DAYS']?{recentDays:Number(process.env['DENTITY_SUMMARY_RECENT_DAYS'])}:{})}},
  databasePath,
  ...(process.env['DENTITY_BUILTIN_RECORD_ROOT'] !== undefined ? { builtinRecordRoot: process.env['DENTITY_BUILTIN_RECORD_ROOT'] } : {}),
  origin: process.env['DENTITY_APP_ORIGIN'] ?? `http://127.0.0.1:${port}`,
  secureCookies: process.env['DENTITY_SECURE_COOKIES'] === 'true',
  modelProfiles: { ...(masterKey ? { masterKey } : {}), allowLoopbackHttp: process.env['DENTITY_MODEL_ALLOW_LOOPBACK_HTTP'] === 'true' },

});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000).unref();
    void server.close().then(() => {
      clearTimeout(deadline);
    }, () => {
      clearTimeout(deadline);
      process.exitCode = 1;
    });
  });
}
try {
  // Local development binding remains loopback. Runtime execution is not ready.
  await server.listen({ host: '127.0.0.1', port });
} catch (error) {
  console.error(error instanceof LegacyConversationStorageError || error instanceof BuiltinTestContextResetRequiredError ? error.message : 'Unable to start control-plane; check the port and local configuration.');
  process.exitCode = 1;
}
