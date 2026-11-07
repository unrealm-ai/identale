import {validateHumanQuestion,type HumanQuestion} from '@dentity/contracts';
import type{ToolDefinition,ExtensionFactory}from'@earendil-works/pi-coding-agent';
/** Public SDK hook fences the complete assistant tool batch, not only calls after ask. */
export function humanRuntime(requestId:string,persist:(question:HumanQuestion)=>Promise<void>,replanOnly=false){
 let question:HumanQuestion|undefined;
 const tool:ToolDefinition={name:'ask_human',label:'Ask a human',description:'Ask the configured human for missing information or an explicit decision before proceeding. Keep user-facing text concise in the user’s language: one short background sentence, direct questions and a brief action/impact. Do not repeat the same facts across fields or put internal IDs, protocol terms or local absolute paths in the message. Put material risks and conditions in the question or impact scope. Preserve complete structured completion criteria for the service; do not turn them into a tutorial. The service chooses the recipient; do not supply identities. This ends this execution segment; wait for a later authorized response.',executionMode:'sequential',parameters:{type:'object',properties:{decisionRequired:{type:'boolean',description:'Defaults to true; false only for an information request without a decision.'},questionScope:{type:'string'},background:{type:'string'},goal:{type:'string'},knownFacts:{type:'array',items:{type:'object',properties:{text:{type:'string'},evidenceRefs:{type:'array',items:{type:'string'}}},required:['text'],additionalProperties:false}},questions:{type:'array',items:{type:'object',properties:{id:{type:'string'},text:{type:'string'},required:{type:'boolean'},answerType:{type:'string',enum:['text','choice','boolean','number']},constraints:{type:'array',items:{type:'string'}}},required:['id','text','required','answerType'],additionalProperties:false}},completionCriteria:{type:'array',items:{type:'string'}},proposedAction:{type:'string'},impactScope:{type:'string'},ifNotConfirmed:{type:'string'}},required:['questionScope','background','goal','knownFacts','questions','completionCriteria','proposedAction','impactScope','ifNotConfirmed'],additionalProperties:false}as ToolDefinition['parameters'],execute:async(_id,args)=>{
  if(question)throw Error('human_request_already_pending');question=validateHumanQuestion(args);await persist(question);
  return{content:[{type:'text',text:JSON.stringify({status:'waiting_human',requestId,contentVersion:1})}],details:{requestId},terminate:true};
 }};
 const extension:ExtensionFactory=pi=>{pi.on('tool_call',(event,ctx)=>{
  const assistant=[...ctx.sessionManager.getBranch()].reverse().find(e=>e.type==='message'&&e.message.role==='assistant');
  const batchAsks=assistant?.type==='message'&&assistant.message.role==='assistant'&&assistant.message.content.some(c=>c.type==='toolCall'&&c.name==='ask_human');
  if(replanOnly&&!['ask_human','context_read','asset_read','progress_report','read','work_item_get_current','work_item_list_handoff_employees'].includes(event.toolName))return{block:true,terminate:true,reason:'Rejected action: only inspection and a new human request are allowed.'};
  if(question||batchAsks&&event.toolName!=='ask_human')return{block:true,terminate:true,reason:'Human confirmation pending; no sibling operation is allowed.'};
 });};
 return{tool,extension,pending:()=>question};
}
