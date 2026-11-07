import type {TriggerContextNamespace,TriggerHistoryPolicy} from './ports.js';
/** Caller must reconcile the event's durable unique key before invoking this for a new Task. */
export function resolveTriggerContext(policy:TriggerHistoryPolicy,businessKey:string|undefined,newId:()=>string):{namespace:TriggerContextNamespace;key:string}{
  if(policy==='employee_shared')return{namespace:'shared',key:'employee-trigger-history-v1'};
  if(policy==='business_key'&&businessKey!==undefined&&businessKey!=='')return{namespace:'business',key:businessKey};
  if(policy!=='isolated'&&policy!=='business_key')throw new Error('invalid_trigger_history_policy');
  return{namespace:'isolated',key:newId()};
}
