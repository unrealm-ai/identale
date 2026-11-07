import test from 'node:test';
import assert from 'node:assert/strict';
import {taskModelView} from '../dist/adapters/task-model-view.js';

function task() {
 return {id:'task-1',input:'Read the requested Skill only',status:'running',version:3,inputRevision:2,createdAt:1,updatedAt:2,
  entityId:'internal-employee',conversationId:'internal-conversation',contextMode:'new',unexpected:'INTERNAL_SENTINEL',
  actionCapabilities:{runtimeId:'local-pi',runtimeVersion:'internal-version',bindingVersion:'internal-binding'},
  availableActions:{query:{available:true,mode:'read'},start:{available:false,reason:'task_terminal',mode:'start_planned'},
   supplement:{available:true,mode:'runtime_input',runtimeDelivery:{support:'supported'},application:'not_guaranteed'},
   cancel:{available:true,mode:'request_cancel',confirmation:'runtime_required'},pause:{available:false,reason:'platform_action_unsupported'},resume:{available:false,reason:'platform_action_unsupported'}},
  actionReceipt:{action:'supplement',operationId:'internal-operation',status:'recorded',inputRevision:2,deliveryMode:'runtime_input',runtimeStatus:'received'},
  run:{id:'internal-run',status:'running',sequence:12,result:null,resultInputRevision:null},
 };
}
const hidden=/runtime|bindingVersion|operationId|runId|eventId|sequence|contextMode|conversationId|entityId|INTERNAL_SENTINEL|internal-/i;
test('task model allowlist preserves actionable facts without internal DTO metadata',()=>{
 const value=taskModelView(task());assert.doesNotMatch(JSON.stringify(value),hidden);
 assert.deepEqual(value.actionReceipt,{action:'supplement',status:'recorded',effectStatus:'received',inputRevision:2});
 assert.deepEqual(value.availableActions.supplement,{available:true,effect:'pending'});
 assert.deepEqual(value.availableActions.cancel,{available:true});
 assert.equal(value.id,'task-1');assert.equal(value.version,3);assert.equal(value.executionStatus,'running');assert.equal(value.result,null);
});
test('supplement records, delayed startup and confirmed application remain distinguishable',()=>{
 const source=task();source.availableActions.supplement.mode='platform_record_only';source.actionReceipt.runtimeStatus='recorded';
 assert.equal(taskModelView(source).availableActions.supplement.effect,'recorded_only');
 source.availableActions.supplement.application='on_start';assert.equal(taskModelView(source).availableActions.supplement.effect,'on_start');
 source.availableActions.supplement.application='not_guaranteed';source.availableActions.supplement.mode='dispatch_input';
 for(const status of ['pending','received','applied','unknown']){source.actionReceipt.runtimeStatus=status;assert.equal(taskModelView(source).actionReceipt.effectStatus,status);}
});
test('planned tasks, already-started cancellation and unknown support cannot imply execution or stopping',()=>{
 const source=task();source.run=null;delete source.actionReceipt;source.status='planned';source.availableActions.cancel.confirmation='platform_confirmed';
 const planned=taskModelView(source);assert.equal('executionStatus' in planned,false);assert.equal('result' in planned,false);assert.equal('actionReceipt' in planned,false);assert.deepEqual(planned.availableActions.cancel,{available:true});
 source.actionReceipt={action:'cancel',status:'already_started',runtimeStatus:'not_started',operationId:'internal-operation'};
 assert.equal(taskModelView(source).actionReceipt.status,'already_started');
 for(const reason of ['permission_denied','task_not_started','task_terminal','cancel_already_requested','run_terminal','runtime_not_bound','runtime_state_unknown','runtime_capability_unknown','runtime_action_unsupported','runtime_not_configured','platform_action_unsupported']){
  source.availableActions.cancel={...source.availableActions.cancel,available:false,reason};const result=taskModelView(source);assert.equal(result.availableActions.cancel.available,false);assert.equal(typeof result.availableActions.cancel.reason,'string');assert.doesNotMatch(JSON.stringify(result),hidden);
 }
});
test('updates, input and delivery receipts are independently allowlisted while business content stays intact',()=>{
 const source=task();source.run.result='Business document mentions Runtime and Adapter';source.run.resultInputRevision=2;
 const result=taskModelView(source,{updates:[{id:1,eventId:'internal-event',runId:'internal-run',sequence:4,type:'progress',text:'第一阶段完成',unexpected:'INTERNAL_SENTINEL'},{type:'input_receipt',inputRevision:2,inputStatus:'received'},{type:'final_result',text:source.run.result,inputRevision:2}],inputs:[{revision:2,status:'received',unexpected:'INTERNAL_SENTINEL'}],deliveries:[{id:'internal-delivery',eventId:'internal-event',status:'pending',text:'已生成结果',createdAt:3,unexpected:'INTERNAL_SENTINEL'}]});
 assert.doesNotMatch(JSON.stringify(result),/internal-|INTERNAL_SENTINEL|runId|eventId|sequence/);
 assert.deepEqual(result.updates[0],{type:'progress',text:'第一阶段完成'});assert.deepEqual(result.inputs,[{revision:2,status:'received'}]);
 assert.deepEqual(result.deliveries,[{status:'pending',text:'已生成结果',createdAt:3}]);assert.equal(result.result,source.run.result);assert.equal(result.resultInputRevision,2);
});

test('527 stream fragments stay in source records and never enter the model task view',()=>{
 const source=task(),text='合成结果：'+'业务说明。'.repeat(130);source.status='succeeded';source.run={...source.run,status:'succeeded',result:text,resultInputRevision:2};
 const fragments=Array.from({length:527},(_,i)=>({type:'output_delta',text:text.slice(Math.floor(i*text.length/527),Math.floor((i+1)*text.length/527))}));
 const updates={updates:[{type:'progress',text:'资料已读取'},...fragments,{type:'final_result',text,inputRevision:2},{type:'status',status:'succeeded'}],inputs:[{revision:2,status:'applied'}],deliveries:[{text,status:'pending',createdAt:3}]};
 const original=JSON.stringify(updates),value=taskModelView(source,updates);
 assert.equal(value.updates.some(u=>u.type==='output_delta'),false);assert.equal(value.updates.length,3);
 assert.equal(value.result,text);assert.equal(value.updates.find(u=>u.type==='final_result').text,text);
 assert.deepEqual(value.inputs,[{revision:2,status:'applied'}]);assert.equal(value.deliveries[0].status,'pending');
 assert.equal(JSON.stringify(updates),original);assert.equal(updates.updates.filter(u=>u.type==='output_delta').length,527);
});
test('unfinished stream fragments cannot imply success and preserve semantic progress and input receipts',()=>{
 const source=task(),updates={updates:[{type:'status',status:'running'},{type:'output_delta',text:'尚未完成的输出'},{type:'progress',text:'完成资料读取'},{type:'partial_result',text:'已核对第一部分',inputRevision:2},{type:'input_receipt',inputRevision:2,inputStatus:'received'}],inputs:[{revision:2,status:'received'}],deliveries:[]};
 const value=taskModelView(source,updates);assert.equal(value.status,'running');assert.equal(value.result,null);assert.deepEqual(value.updates.map(u=>u.type),['status','progress','partial_result','input_receipt']);assert.equal(value.updates.at(-1).inputStatus,'received');
 assert.deepEqual(taskModelView(source,{updates:[],inputs:[],deliveries:[]}).updates,[]);
 assert.deepEqual(taskModelView(source,{updates:[{type:'output_delta',text:'片段'}],inputs:[],deliveries:[]}).updates,[]);
});
