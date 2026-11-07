// User-approved deterministic local model and real HTTP MCP protocol fixtures.
// No real business data or credentials; all MCP execution happens through the pi SDK.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createMcpServer} from '../../../mock-model/dist/mcp-server.js';
export const qaSchema={type:'object',properties:{},additionalProperties:false};
export function qaResources(endpoint){
 const skills=['alpha','beta'].map(label=>{const content=`# QA ${label}\nQA_BUSINESS_${label.toUpperCase()}_20261024: synthetic reviewed business guidance.\n`;return{resourceId:`qa-business-${label}-20261024`,version:'1',name:`qa-${label}`,description:`QA ${label}`,content,digest:createHash('sha256').update(content).digest('hex')};});
 const mcpServers=['alpha','beta'].map(label=>({serverRef:`qa_${label}`,endpoint:endpoint+'/'+label,tools:[{name:'lookup',description:`QA ${label} business lookup`,inputSchema:qaSchema}]}));
 const approved=[...skills.map(s=>({id:s.resourceId,kind:'skill',shared:true,resourceId:s.resourceId,version:s.version,digest:s.digest})),...mcpServers.map((s,i)=>({id:`qa-mcp-${['alpha','beta'][i]}-20261024`,kind:'mcp',shared:true,serverRef:s.serverRef,allowedTools:['lookup']}))];
 return{registry:{skills,mcpServers},approved};
}
export function qaMcp(audit){return createMcpServer({observe:audit,description:label=>`QA ${label} business lookup`});}
const content=m=>typeof m.content==='string'?m.content:JSON.stringify(m.content??'');
export function qaModel(upstream,observe,options={}){return createServer(async(req,res)=>{
 try{let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
 if(!body.stream||options.forwardStream?.(body)){observe({stream:!!body.stream,toolSchemas:(body.tools??[]).map(t=>({name:t.function.name,description:t.function.description,arguments:Object.keys(t.function.parameters?.properties??{})}))});const r=await fetch(upstream+req.url,{method:req.method,headers:{authorization:req.headers.authorization??'','content-type':'application/json'},...(req.method==='GET'?{}:{body:raw})});res.writeHead(r.status,{'content-type':r.headers.get('content-type')??'application/json'});res.end(await r.text());return;}
 const messages=body.messages??[],system=messages.filter(m=>['system','developer'].includes(m.role)).map(content).join('\n'),input=messages.filter(m=>m.role==='user').map(content).join('\n'),tools=(body.tools??[]).map(t=>t.function.name),calls=messages.flatMap(m=>m.tool_calls??[]),called=calls.map(c=>c.function.name),alpha=(system.includes('QA_BUSINESS_ALPHA_20261024')||system.includes('LOCAL_MOCK_SKILL_ALPHA')),beta=!!(system.includes('QA_BUSINESS_BETA_20261024')||system.includes('LOCAL_MOCK_SKILL_BETA')||options.betaName&&system.includes('Registered skill '+options.betaName+' ')),force=input.includes('QA_FORCE_FORBIDDEN');
 const authorized=tools.find(t=>t.startsWith('mcp__qa_')||t.startsWith('mcp__ws_mcp_')),forbidden=options.forbiddenFor?.(authorized)??(authorized?.includes('alpha')?'mcp__qa_beta__lookup':'mcp__qa_alpha__lookup');await observe({stream:true,alpha,beta,tools,force,called});
 const skillRoots=[...system.matchAll(/(?:Registered skill|Skill) ([a-z0-9-]+) \(files: ([^\r\n)]+)\):/g)].sort((a,b)=>a[1].localeCompare(b[1])).map(m=>m[2]);
 const attachmentRead=skillRoots.map(root=>root+'/assets/marker.txt').find(path=>!calls.some(c=>c.function.name==='read'&&JSON.parse(c.function.arguments??'{}').path===path));
 const attachmentCommand=skillRoots.map(root=>JSON.stringify(process.execPath)+' '+JSON.stringify(root+'/scripts/check.mjs')).find(command=>!calls.some(c=>c.function.name==='bash'&&JSON.parse(c.function.arguments??'{}').command===command));
 let name,args,text;
 if(options.scopedHistory){const toolResult=name=>{const call=calls.find(c=>c.function.name===name);const message=messages.find(m=>m.role==='tool'&&m.tool_call_id===call?.id);try{return JSON.parse(content(message??{}));}catch{return{};}};if(!called.includes('list_readable_contexts')){name='list_readable_contexts';args={};}else{const group=toolResult('list_readable_contexts').items?.find(i=>i.type==='trigger_history');if(group&&!called.includes('list_trigger_task_history')){name='list_trigger_task_history';args={contextRef:group.contextRef};}else{const record=toolResult('list_trigger_task_history').items?.flatMap(i=>i.runs??[]).flatMap(r=>r.records??[]).find(r=>r.recordRef);if(record&&!called.includes('read_trigger_task_record')){name='read_trigger_task_record';args={recordRef:record.recordRef};}else text=record?'QA_SCOPED_HISTORY_READ':'QA_NO_PRIOR_HISTORY';}}}
 else if(force){if(!called.includes(forbidden)){name=forbidden;args={};}else text='QA_UNAUTHORIZED_TOOL_REJECTED';}
 else if(options.allMcp&&tools.some(t=>t.startsWith('mcp__')&&!called.includes(t))){name=tools.find(t=>t.startsWith('mcp__')&&!called.includes(t));args={};}
 else if(authorized&&!called.includes(authorized)){name=authorized;args={};}
 else if(options.attachmentFiles&&[...system.matchAll(/(?:Registered skill|Skill) ([a-z0-9-]+) \(files: ([^\r\n)]+)\):/g)].flatMap(m=>options.attachmentFiles(m[1],m[2])).some(path=>!calls.some(c=>c.function.name==='read'&&JSON.parse(c.function.arguments??'{}').path===path))){const path=[...system.matchAll(/(?:Registered skill|Skill) ([a-z0-9-]+) \(files: ([^\r\n)]+)\):/g)].flatMap(m=>options.attachmentFiles(m[1],m[2])).find(path=>!calls.some(c=>c.function.name==='read'&&JSON.parse(c.function.arguments??'{}').path===path));name='read';args={path,limit:12};}
 else if(options.attachments&&attachmentRead){name='read';args={path:attachmentRead};}
 else if(options.attachments&&attachmentCommand){name='bash';args={command:attachmentCommand};}
 else if(options.historyReads&&[...input.replaceAll('\\\"','\"').matchAll(/"readOnlyPath":"([^"]+)"/g)].some(m=>!calls.some(c=>c.function.name==='read'&&JSON.parse(c.function.arguments??'{}').path===m[1]))){name='read';args={path:[...input.replaceAll('\\\"','\"').matchAll(/"readOnlyPath":"([^"]+)"/g)].find(m=>!calls.some(c=>c.function.name==='read'&&JSON.parse(c.function.arguments??'{}').path===m[1]))[1],limit:100};}
 else if(!called.includes('write')){name='write';args={path:'article.md',content:'# QA article\n'+(alpha?'ALPHA':'BETA')+'\n'};}
 else if(!called.includes('read')){name='read';args={path:'article.md'};}
 else if(!called.includes('bash')){name='bash';args={command:'test -f article.md && printf QA_ARTICLE_CHECKED'};}
 else text='QA business result: article.md verified.';
 const chunk=(delta,finish=null)=>'data: '+JSON.stringify({id:'qa-completion',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(chunk({role:'assistant'})+chunk(name?{tool_calls:[{index:0,id:'qa-call-'+(calls.length+1),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:text})+chunk({},name?'tool_calls':'stop')+'data: '+JSON.stringify({id:'qa-completion',object:'chat.completion.chunk',created:1,model:body.model,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');
 }catch{res.writeHead(500);res.end();}
});}
