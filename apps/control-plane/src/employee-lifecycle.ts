import type {FastifyInstance,FastifyRequest} from 'fastify';
import {TaskError,accountInput,type EntityService} from '@dentity/application';
import type {Store} from './store.js';
import type {EmployeeChannelService} from './employee-channels/service.js';
import {employeeHasPendingWork,type EmployeeLifecycleTransition} from './split/lifecycle-control.js';

/** Infrastructure orchestration: lifecycle is independent of history/use ACLs. */
export function registerEmployeeLifecycle(app:FastifyInstance,services:{store:Store;entities:EntityService;channels:EmployeeChannelService;auth:(request:FastifyRequest)=>{id:string};now:()=>number;transition?:EmployeeLifecycleTransition}){
 const {store,entities,channels}=services;
 app.put('/api/workspaces/:workspaceId/entities/:entityId/status',async request=>{
  const {workspaceId:w,entityId:e}=request.params as {workspaceId:string;entityId:string},actor=services.auth(request).id;
  entities.requireManager(actor,w,e);const input=accountInput(request.body,['enabled','expectedRevision']);
  if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1)throw new TaskError(400,'invalid_employee_status');
  const work=()=>{const changed:string[]=[];
  const result=store.transaction(()=>{
   entities.requireManager(actor,w,e);const row=store.one<{lifecycle_enabled:number;lifecycle_revision:number}>('SELECT lifecycle_enabled,lifecycle_revision FROM entities WHERE workspace_id=? AND id=?',w,e)!;
   if(row.lifecycle_revision!==input.expectedRevision)throw new TaskError(409,'employee_state_changed');
   if(Boolean(row.lifecycle_enabled)===input.enabled)return {entity:entities.requireReader(actor,w,e)};
   if(!input.enabled){
    if(!services.transition&&employeeHasPendingWork(store,w,e,services.now()))throw new TaskError(409,'employee_has_pending_work');
    // Existing channel settings preserve identity/credentials and revoke old ingress generations.
    for(const channel of channels.repository.list(w,e))if(channel.enabled){const next={...channel,enabled:false,status:'disabled' as const,revision:channel.revision+1,updatedBy:actor};if(!channels.repository.save(next,channel))throw new TaskError(409,'channel_configuration_changed');channels.repository.audit(next,actor,'employee_disabled',services.now());changed.push(channel.id);}
   }
   store.run('UPDATE entities SET lifecycle_enabled=?,lifecycle_revision=lifecycle_revision+1 WHERE workspace_id=? AND id=?',input.enabled?1:0,w,e);
   store.run('INSERT INTO audit(at,action,user_id,workspace_id) VALUES(?,?,?,?)',services.now(),input.enabled?'employee.enabled':'employee.disabled',actor,w);
   return {entity:entities.requireReader(actor,w,e)};
  });
  // Repeat notifications after outer commit so no SDK start observes an uncommitted state.
  for(const id of changed)channels.notifyCommitted(id);return result;};
  return services.transition?services.transition({workspaceId:w,entityId:e,actorId:actor,enabled:input.enabled,expectedRevision:Number(input.expectedRevision)},work):work();
 });
}
