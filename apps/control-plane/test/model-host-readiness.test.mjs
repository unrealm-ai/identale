import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import {HttpTaskRuntime} from '../dist/runtime-http.js';
import {PassiveMaterials} from '../../runtime-host-pi/dist/materials.js';
for(const protocol of ['chat_completions','openai_responses','anthropic_messages'])test(`${protocol} prewarm verifies Host protocol acknowledgement without treating saved configuration as SDK warm`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'identity-protocol-ready-')),store=new Store(join(root,'isolated.sqlite')),host=new PassiveMaterials(join(root,'host'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','user','User')");store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u')");store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Entity','m','m',1,'u','builtin')");
 const profiles=new ModelProfileService(store,{masterKey:Buffer.alloc(32,6)});profiles.save('w','e',{provider:'openai-compatible',protocol,endpoint:'https://synthetic.invalid/v1',modelId:'fixture',apiKey:'synthetic-key'});
 const runtime=new HttpTaskRuntime(store,profiles,{url:'http://127.0.0.1:1',token:'synthetic-host-token-00000000000000000'},()=>1000,{preparationResources:()=>({skills:[],mcpServers:[]})});let responseMode='legacy',seen;
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.match(String(url),/^http:\/\/127\.0\.0\.1:1\/v2\/materials\/(?:inspect|configuration)$/);const body=JSON.parse(options.body);let status;try{status=String(url).endsWith('/configuration')?host.putConfiguration(body):host.inspect(body.configurationId);}catch{return Response.json({error:'missing'},{status:409});}seen=status;const result={...status,hostId:'host'};if(responseMode==='legacy')delete result.modelProtocol;else if(responseMode==='wrong')result.modelProtocol=protocol==='anthropic_messages'?'openai_responses':'anthropic_messages';return Response.json(result);});
 await runtime.prepareConfigured();assert.equal(!!runtime.preparation('w','e').prepared,protocol==='chat_completions','Only legacy Chat Completions remains compatible without explicit protocol ack');assert.equal(seen.sdk,'initializes_on_submit');assert.equal(seen.modelProtocol,protocol);
 responseMode='wrong';await runtime.prepareConfigured();if(protocol!=='chat_completions')assert.equal(runtime.preparation('w','e').prepared,null,'A different acknowledged protocol cannot silently execute the package');
 responseMode='exact';await runtime.prepareConfigured();assert.equal(runtime.preparation('w','e').prepared,seen.configurationId);assert.equal(seen.modelProtocol,protocol);
});
