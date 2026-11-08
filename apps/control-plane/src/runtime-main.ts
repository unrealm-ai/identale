import {createRuntimeServer} from './split/server.js';
import {LegacyConversationStorageError} from './store.js';
import {BuiltinTestContextResetRequiredError} from './adapters/sqlite/builtin-stores.js';
import {defaultDatabasePath, expandHomePath} from './storage-config.js';

const rawPort=process.env['DENTITY_RUNTIME_SERVICE_PORT']??'18304';
const port=Number(rawPort);
if(!/^\d+$/.test(rawPort)||!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('DENTITY_RUNTIME_SERVICE_PORT must be an integer between 1 and 65535');
const platformUrl=process.env['DENTITY_PLATFORM_CONFIG_URL'];
const platformToken=process.env['DENTITY_PLATFORM_CONFIG_TOKEN'];
const serviceToken=process.env['DENTITY_RUNTIME_SERVICE_TOKEN'];
if(!platformUrl||!platformToken||!serviceToken)throw new Error('Runtime service requires its platform configuration endpoint and distinct service credentials');
if(platformToken===serviceToken)throw new Error('Platform configuration and runtime service tokens must be distinct');
const rawPollMs=process.env['DENTITY_PLATFORM_CONFIG_POLL_INTERVAL_MS'];
const pollMs=rawPollMs===undefined?undefined:Number(rawPollMs);
if(pollMs!==undefined&&(!Number.isSafeInteger(pollMs)||pollMs<100))throw new Error('DENTITY_PLATFORM_CONFIG_POLL_INTERVAL_MS must be an integer of at least 100 milliseconds');
const hostUrl=process.env['DENTITY_RUNTIME_HOST_URL'];
const hostToken=process.env['DENTITY_RUNTIME_HOST_TOKEN'];
if((hostUrl||hostToken)&&!(hostUrl&&hostToken))throw new Error('Runtime host URL and authentication token must be configured together');
const server=createRuntimeServer({
  captureInvalidModelResponses:process.env['DENTITY_DEPLOYMENT']!=='server',
  databasePath:expandHomePath(process.env['DENTITY_RUNTIME_DATABASE_PATH']??defaultDatabasePath('runtime')),
  platformConfig:{url:platformUrl,token:platformToken,...(pollMs===undefined?{}:{pollMs})},
  serviceToken,
  origin:process.env['DENTITY_APP_ORIGIN']??'http://127.0.0.1:15173',
  secureCookies:process.env['DENTITY_SECURE_COOKIES']==='true',
  triggers:{allowLoopbackHttp:process.env['DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP']==='true'},
  mcpResources:{allowedOrigins:(process.env['DENTITY_MCP_ALLOWED_ORIGINS']??'').split(',').filter(Boolean),allowLoopbackHttp:process.env['DENTITY_MODEL_ALLOW_LOOPBACK_HTTP']==='true'},
  modelProfiles:{allowLoopbackHttp:process.env['DENTITY_MODEL_ALLOW_LOOPBACK_HTTP']==='true'},
  ...(process.env['DENTITY_FEISHU_BUSINESS_OAUTH_REDIRECT_URI']?{businessOAuth:{redirectUri:process.env['DENTITY_FEISHU_BUSINESS_OAUTH_REDIRECT_URI']}}:{}),
  ...(process.env['DENTITY_BUILTIN_RECORD_ROOT']===undefined?{}:{builtinRecordRoot:process.env['DENTITY_BUILTIN_RECORD_ROOT']}),
  maintenance:{enabled:process.env['DENTITY_MAINTENANCE_ENABLED']!=='false',...(process.env['DENTITY_MAINTENANCE_INTERVAL_MS']?{intervalMs:Number(process.env['DENTITY_MAINTENANCE_INTERVAL_MS'])}:{}),policy:{...(process.env['DENTITY_CONTEXT_RETAIN_MESSAGES']?{retainMessages:Number(process.env['DENTITY_CONTEXT_RETAIN_MESSAGES'])}:{}),...(process.env['DENTITY_CONTEXT_TOKEN_THRESHOLD']?{contextTokenThreshold:Number(process.env['DENTITY_CONTEXT_TOKEN_THRESHOLD'])}:{}),...(process.env['DENTITY_SUMMARY_TIMEZONE']?{timezone:process.env['DENTITY_SUMMARY_TIMEZONE']}:{}),...(process.env['DENTITY_SUMMARY_RECENT_DAYS']?{recentDays:Number(process.env['DENTITY_SUMMARY_RECENT_DAYS'])}:{})}},
  ...(hostUrl&&hostToken?{runtimeHost:{url:hostUrl,token:hostToken,workItemUrl:`http://127.0.0.1:${port}/internal/runtime/work-items`,groupHistoryUrl:`http://127.0.0.1:${port}/internal/runtime/group-history`}}:{}),
});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
  if(stopping)return;
  stopping=true;
  const deadline=setTimeout(()=>process.exit(1),10_000).unref();
  void server.close().then(()=>clearTimeout(deadline),()=>{clearTimeout(deadline);process.exitCode=1;});
});
try{await server.listen({host:'127.0.0.1',port});}
catch(error){
  await server.close().catch(()=>{});
  console.error(error instanceof LegacyConversationStorageError||error instanceof BuiltinTestContextResetRequiredError?error.message:'Unable to start runtime service; check the port and local configuration.');
  process.exitCode=1;
}
