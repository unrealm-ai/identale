import type {ModelProtocol}from'@dentity/contracts';
type Json=Record<string,unknown>;
const object=(value:unknown):Json=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid model protocol object');return value as Json;};
const list=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const text=(value:unknown)=>typeof value==='string'?value:'';
export function modelProtocolEndpoint(base:string,protocol:ModelProtocol='chat_completions'){
 const root=base.replace(/\/+$/,'');return protocol==='anthropic_messages'?root.replace(/\/v1$/,'')+'/v1/messages':root+(protocol==='openai_responses'?'/responses':'/chat/completions');
}
export function modelProtocolHeaders(key:string,protocol:ModelProtocol='chat_completions'){
 return protocol==='anthropic_messages'?{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'}:{'content-type':'application/json',authorization:'Bearer '+key};
}
/** Input is an internal Chat-shaped wire value assembled from authorized references, never raw vendor history. */
export function modelProtocolRequest(value:Json,protocol:ModelProtocol='chat_completions'):Json{
 if(protocol==='chat_completions')return value;
 const messages=list(value.messages).map(object),tools=list(value.tools).map(object).map(t=>object(t.function));
 if(protocol==='openai_responses'){
  const input:unknown[]=[];
  for(const m of messages){
   if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.tool_call_id,output:m.content});continue;}
   if(m.content){const content=typeof m.content==='string'?[{type:m.role==='assistant'?'output_text':'input_text',text:m.content,...(m.role==='assistant'?{annotations:[]}:{})}]:list(m.content).map(raw=>{const part=object(raw);if(part.type==='text')return{type:'input_text',text:part.text};if(part.type==='image_url')return{type:'input_image',image_url:object(part.image_url).url};throw Error('Unsupported Responses content');});input.push({role:m.role,content,...(m.role==='assistant'?{type:'message',status:'completed',id:'msg_builtin_'+input.length}:{})});}
   for(const raw of list(m.tool_calls)){const call=object(raw),fn=object(call.function);input.push({type:'function_call',call_id:call.id,name:fn.name,arguments:fn.arguments});}
  }
  return{model:value.model,input,max_output_tokens:value.max_completion_tokens,stream:value.stream===true,store:false,reasoning:{effort:'none'},...(tools.length?{tools:tools.map(t=>({type:'function',name:t.name,description:t.description,parameters:t.parameters,strict:false})),parallel_tool_calls:false,...(value.tool_choice==='none'?{tool_choice:'none'}:{})}:{})};
 }
 const system=messages.filter(m=>m.role==='system').map(m=>text(m.content)).join('\n'),output:{role:'user'|'assistant';content:unknown[]}[]=[];
 for(const m of messages){if(m.role==='system')continue;
  const role=m.role==='assistant'?'assistant':'user',content:unknown[]=m.role==='tool'?[{type:'tool_result',tool_use_id:m.tool_call_id,content:text(m.content)}]:typeof m.content==='string'?(m.content?[{type:'text',text:m.content}]:[]):list(m.content).map(raw=>{const part=object(raw);if(part.type==='text')return{type:'text',text:part.text};if(part.type==='image_url'){const url=text(object(part.image_url).url),match=/^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(url);if(!match)throw Error('Only authorized embedded images are accepted');return{type:'image',source:{type:'base64',media_type:match[1],data:match[2]}};}throw Error('Unsupported Anthropic content');});
  for(const raw of list(m.tool_calls)){const call=object(raw),fn=object(call.function);content.push({type:'tool_use',id:call.id,name:fn.name,input:JSON.parse(text(fn.arguments))});}
  if(!content.length)continue;const previous=output.at(-1);if(previous?.role===role)previous.content.push(...content);else output.push({role,content});
 }
 return{model:value.model,system,messages:output,max_tokens:value.max_completion_tokens,stream:value.stream===true,...(tools.length?{tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.parameters})),...(value.tool_choice==='none'?{tool_choice:{type:'none'}}:{tool_choice:{type:'auto',disable_parallel_tool_use:true}})}:{})};
}
/** Normalize complete non-stream replies; callers retain their existing validation and tool authority checks. */
export function modelProtocolResponse(value:unknown,protocol:ModelProtocol='chat_completions'):unknown{
 if(protocol==='chat_completions')return value;
 const body=object(value),calls:unknown[]=[],texts:string[]=[];
 if(protocol==='openai_responses'){
  for(const raw of list(body.output)){const item=object(raw);if(item.type==='function_call'){if(typeof item.call_id!=='string'||typeof item.name!=='string'||typeof item.arguments!=='string')throw Error('Invalid Responses tool call');calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});}else if(item.type==='message')for(const rawPart of list(item.content)){const part=object(rawPart);if(part.type==='output_text'&&typeof part.text==='string')texts.push(part.text);else if(part.type==='refusal'&&typeof part.refusal==='string')texts.push(part.refusal);}}
  const usage=body.usage?object(body.usage):{};
  // Only an explicit token-limit stop is eligible for semantic compression retry.
  // A refusal/filter or unspecified incomplete response is not proven truncation.
  const incompleteReason=body.incomplete_details&&typeof body.incomplete_details==='object'&&!Array.isArray(body.incomplete_details)?(body.incomplete_details as Json).reason:undefined;
  return{choices:[{finish_reason:body.status==='incomplete'?(incompleteReason==='max_output_tokens'?'length':'invalid'):body.status==='completed'?(calls.length?'tool_calls':'stop'):'invalid',message:{role:'assistant',content:texts.join(''),...(calls.length?{tool_calls:calls}:{})}}],usage:{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens}};
 }
 for(const raw of list(body.content)){const part=object(raw);if(part.type==='text'&&typeof part.text==='string')texts.push(part.text);else if(part.type==='tool_use'){if(typeof part.id!=='string'||typeof part.name!=='string'||!part.input||typeof part.input!=='object')throw Error('Invalid Anthropic tool call');calls.push({id:part.id,type:'function',function:{name:part.name,arguments:JSON.stringify(part.input)}});}}
 const usage=body.usage?object(body.usage):{};
 return{choices:[{finish_reason:body.stop_reason==='max_tokens'?'length':body.stop_reason==='tool_use'?'tool_calls':['end_turn','stop_sequence'].includes(text(body.stop_reason))?'stop':'invalid',message:{role:'assistant',content:texts.join(''),...(calls.length?{tool_calls:calls}:{})}}],usage:{prompt_tokens:Number(usage.input_tokens)+Number(usage.cache_read_input_tokens??0)+Number(usage.cache_creation_input_tokens??0),completion_tokens:usage.output_tokens}};
}
