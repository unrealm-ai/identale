import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {TaskError} from '@dentity/application';
import type {Store} from '../store.js';
import {serviceEndpoint,serviceToken} from './service-transport.js';

export const EMPLOYEE_LIFECYCLE_FENCE_SCHEMA = `CREATE TABLE IF NOT EXISTS employee_lifecycle_fences (
 workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 target_enabled INTEGER NOT NULL CHECK(target_enabled IN (0,1)),
 source_enabled INTEGER NOT NULL CHECK(source_enabled IN (0,1)), source_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','committed')), created_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,entity_id)
)`;
export interface EmployeeLifecycleRequest {workspaceId:string;entityId:string;actorId:string;enabled:boolean;expectedRevision:number}
export type EmployeeLifecycleTransition = (request:EmployeeLifecycleRequest,work:()=>unknown)=>Promise<unknown>;
type Scope = {workspaceId:string;entityId:string};
type Reservation = Scope & {operationId:string;enabled:boolean;expectedRevision:number};
type Release = Scope & {operationId:string;outcome:'committed'|'rolled_back'};
type Fence = {workspace_id:string;entity_id:string;operation_id:string;target_enabled:number;source_enabled:number;source_revision:number;status:'reserved'|'committed'};

/** Original lifecycle busy rules, evaluated only where the durable runtime facts live. */
export function employeeHasPendingWork(store:Store,w:string,e:string,now:number):boolean {
 const exists=(sql:string,...args:(string|number)[])=>!!store.one(sql,...args);
 const existsIn=(table:string,sql:string,...args:(string|number)[])=>!!store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table)&&exists(sql,...args);
 const legacyQueue=!store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_message_receipts'");
 return exists("SELECT id FROM tasks WHERE workspace_id=? AND entity_id=? AND status NOT IN ('planned','succeeded','failed','canceled') LIMIT 1",w,e)
  ||exists("SELECT t.id FROM interaction_turns t JOIN conversations c ON c.id=t.conversation_id WHERE c.workspace_id=? AND c.entity_id=? AND t.status NOT IN ('succeeded','failed','canceled') LIMIT 1",w,e)
  ||exists("SELECT o.id FROM task_outbox o JOIN tasks t ON t.id=o.task_id WHERE t.workspace_id=? AND t.entity_id=? AND o.status IN ('pending','leased') LIMIT 1",w,e)
  ||existsIn('business_notification_jobs',"SELECT id FROM business_notification_jobs WHERE workspace_id=? AND entity_id=? AND state IN ('pending','generating','ready','unknown') LIMIT 1",w,e)
  ||exists("SELECT n.id FROM task_completion_notifications n JOIN tasks t ON t.id=n.task_id WHERE t.workspace_id=? AND t.entity_id=? AND n.status IN ('pending','leased') LIMIT 1",w,e)
  ||exists("SELECT t.id FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.workspace_id=? AND t.entity_id=? AND t.status IN ('succeeded','failed') AND c.mode='real' AND (c.expires_at=0 OR c.expires_at>?) AND NOT EXISTS(SELECT 1 FROM task_completion_notifications n WHERE n.task_id=t.id AND n.run_id=t.run_id) LIMIT 1",w,e,now)
  ||legacyQueue&&existsIn('channel_inbox',"SELECT id FROM channel_inbox WHERE json_extract(scope_json,'$.workspaceId')=? AND json_extract(scope_json,'$.entityId')=? AND status IN ('queued','leased','waiting','blocked','unknown') LIMIT 1",w,e)
  ||legacyQueue&&existsIn('channel_deliveries',"SELECT id FROM channel_deliveries WHERE json_extract(scope_json,'$.workspaceId')=? AND json_extract(scope_json,'$.entityId')=? AND status IN ('queued','sending','blocked','accepted','unknown') LIMIT 1",w,e)
  ||existsIn('channel_message_receipts',"SELECT r.id FROM channel_message_receipts r JOIN employee_channel_connections c ON c.id=r.connection_id WHERE c.workspace_id=? AND c.entity_id=? AND r.status IN ('queued','leased','waiting','blocked','sending','accepted','unknown') LIMIT 1",w,e)
  ||exists("SELECT id FROM scheduled_jobs WHERE status='running' AND json_extract(payload_json,'$.session.runtime.workspaceId')=? AND json_extract(payload_json,'$.session.runtime.entityId')=? LIMIT 1",w,e);
}
/** A durable reservation closes new admission while the platform commits its own configuration. */
export class EmployeeLifecycleController {
 constructor(private readonly options:{store:Store;now:()=>number;onFenceChanged?:(workspaceId:string,entityId:string)=>void}) {
  options.store.db.exec(EMPLOYEE_LIFECYCLE_FENCE_SCHEMA);
 }
 reserve(input:Reservation):{reserved:boolean;operationId:string} {
  const {store}=this.options;
  const result=store.transaction(()=>{
   const fence=store.one<Fence>('SELECT * FROM employee_lifecycle_fences WHERE workspace_id=? AND entity_id=?',input.workspaceId,input.entityId);
   if(fence){if(fence.operation_id===input.operationId&&fence.target_enabled===Number(input.enabled)&&fence.source_revision===input.expectedRevision)return{reserved:true,operationId:input.operationId};throw new TaskError(409,'employee_lifecycle_pending');}
   const row=store.one<{lifecycle_enabled:number;lifecycle_revision:number}>('SELECT lifecycle_enabled,lifecycle_revision FROM entities WHERE workspace_id=? AND id=?',input.workspaceId,input.entityId);
   if(!row)throw new TaskError(409,'employee_configuration_not_applied');
   if(row.lifecycle_revision!==input.expectedRevision)throw new TaskError(409,'employee_state_changed');
   if(Boolean(row.lifecycle_enabled)===input.enabled)return{reserved:false,operationId:input.operationId};
   if(!input.enabled&&employeeHasPendingWork(store,input.workspaceId,input.entityId,this.options.now()))throw new TaskError(409,'employee_has_pending_work');
   store.run("INSERT INTO employee_lifecycle_fences(workspace_id,entity_id,operation_id,target_enabled,source_enabled,source_revision,status,created_at) VALUES(?,?,?,?,?,?,'reserved',?)",input.workspaceId,input.entityId,input.operationId,Number(input.enabled),row.lifecycle_enabled,row.lifecycle_revision,this.options.now());
   store.run('UPDATE entities SET lifecycle_enabled=0 WHERE workspace_id=? AND id=?',input.workspaceId,input.entityId);
   return{reserved:true,operationId:input.operationId};
  });
  if(result.reserved)this.options.onFenceChanged?.(input.workspaceId,input.entityId);
  return result;
 }
 release(input:Release):{pending:boolean} {
  const {store}=this.options;
  const result=store.transaction(()=>{
   const fence=store.one<Fence>('SELECT * FROM employee_lifecycle_fences WHERE workspace_id=? AND entity_id=?',input.workspaceId,input.entityId);
   if(!fence)return{pending:false};
   if(fence.operation_id!==input.operationId)throw new TaskError(409,'employee_lifecycle_pending');
   if(input.outcome==='rolled_back'&&fence.status==='committed')throw new TaskError(409,'employee_lifecycle_pending');
   if(input.outcome==='committed'){
    store.run("UPDATE employee_lifecycle_fences SET status='committed' WHERE operation_id=?",input.operationId);
    // A success acknowledgement alone cannot prove the configuration cache is current.
    return{pending:true};
   }
   store.run('DELETE FROM employee_lifecycle_fences WHERE operation_id=?',input.operationId);
   store.run('UPDATE entities SET lifecycle_enabled=? WHERE workspace_id=? AND id=? AND lifecycle_revision=?',fence.source_enabled,input.workspaceId,input.entityId,fence.source_revision);
   return{pending:false};
  });
  this.options.onFenceChanged?.(input.workspaceId,input.entityId);return result;
 }
 /** Must run synchronously after every coherent configuration replacement, before ingress resumes. */
 reconcile():void {
  const {store}=this.options,changed:Scope[]=[];
  store.transaction(()=>{
   for(const fence of store.all<Fence>('SELECT * FROM employee_lifecycle_fences')){
    const row=store.one<{lifecycle_revision:number}>('SELECT lifecycle_revision FROM entities WHERE workspace_id=? AND id=?',fence.workspace_id,fence.entity_id);
    // Any later lifecycle revision makes the old platform CAS impossible, regardless of outcome.
    if(!row||row.lifecycle_revision>fence.source_revision)store.run('DELETE FROM employee_lifecycle_fences WHERE operation_id=?',fence.operation_id);
    else store.run('UPDATE entities SET lifecycle_enabled=0 WHERE workspace_id=? AND id=?',fence.workspace_id,fence.entity_id);
    changed.push({workspaceId:fence.workspace_id,entityId:fence.entity_id});
   }
  });
  for(const scope of changed)this.options.onFenceChanged?.(scope.workspaceId,scope.entityId);
 }
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function operationId(value:unknown):asserts value is string{if(typeof value!=='string'||!value||value.length>160)throw new TaskError(400,'invalid_employee_status');}
export function registerLifecycleControl(app:FastifyInstance,options:{controller:EmployeeLifecycleController;authorize:(request:FastifyRequest,workspaceId:string,entityId:string)=>void;authenticate?:(request:FastifyRequest)=>void;refresh?:()=>Promise<unknown>}):void {
 const prefix='/internal/control/employees/:workspaceId/:entityId/lifecycle';
 app.post(prefix+'/reserve',async request=>{
  const p=request.params as Scope;if(options.authenticate)options.authenticate(request);else options.authorize(request,p.workspaceId,p.entityId);await options.refresh?.();options.authorize(request,p.workspaceId,p.entityId);
  const input=request.body;if(!record(input)||Object.keys(input).some(k=>!['operationId','enabled','expectedRevision'].includes(k))||typeof input['enabled']!=='boolean'||!Number.isSafeInteger(input['expectedRevision'])||Number(input['expectedRevision'])<1)throw new TaskError(400,'invalid_employee_status');operationId(input['operationId']);
  return options.controller.reserve({...p,operationId:input['operationId'],enabled:input['enabled'],expectedRevision:Number(input['expectedRevision'])});
 });
 app.post(prefix+'/release',async request=>{
  const p=request.params as Scope;options.authorize(request,p.workspaceId,p.entityId);
  const input=request.body;if(!record(input)||Object.keys(input).some(k=>!['operationId','outcome'].includes(k))||!['committed','rolled_back'].includes(String(input['outcome'])))throw new TaskError(400,'invalid_employee_status');operationId(input['operationId']);
  const result=options.controller.release({...p,operationId:input['operationId'],outcome:input['outcome'] as Release['outcome']});
  if(input['outcome']==='committed')await options.refresh?.();return result;
 });
}
/** The callback stays synchronous: no SQLite transaction is held over an HTTP await. */
export function remoteLifecycleTransition(options:{url:string;token:string;fetch?:typeof fetch}):EmployeeLifecycleTransition {
 const origin=serviceEndpoint(options.url);serviceToken(options.token);const transport=options.fetch??fetch;
 async function call(input:EmployeeLifecycleRequest,action:string,body:unknown){
  let response:Response;try{response=await transport(origin+`/internal/control/employees/${encodeURIComponent(input.workspaceId)}/${encodeURIComponent(input.entityId)}/lifecycle/`+action,{method:'POST',headers:{authorization:'Bearer '+options.token,'x-dentity-actor':input.actorId,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new TaskError(503,'employee_lifecycle_unavailable');}
  const data=await response.json() as {reserved?:boolean;error?:string};if(!response.ok)throw new TaskError(response.status,typeof data.error==='string'?data.error:'employee_lifecycle_unavailable');return data;
 }
 const run:EmployeeLifecycleTransition=async(input,work)=>{
  const id=createHash('sha256').update(JSON.stringify([input.workspaceId,input.entityId,input.expectedRevision,input.enabled])).digest('hex'),reservation=await call(input,'reserve',{operationId:id,enabled:input.enabled,expectedRevision:input.expectedRevision});
  if(typeof reservation.reserved!=='boolean')throw new TaskError(503,'employee_lifecycle_unavailable');
  let result:unknown;
  try{result=work();}catch(error){if(reservation.reserved&&!(error instanceof TaskError&&error.code==='employee_state_changed'))try{await call(input,'release',{operationId:id,outcome:'rolled_back'});}catch{/* Unknown release keeps the durable runtime fence until reconciliation. */}throw error;}
  if(reservation.reserved)try{await call(input,'release',{operationId:id,outcome:'committed'});}catch{/* Platform commit is known; runtime stays fenced until its configuration poll observes it. */}
  return result;
 };
 // The current platform is one process. Serialize its duplicate coordinators so a
 // losing CAS cannot roll back the fence belonging to the winning transaction.
 const tails=new Map<string,Promise<void>>();
 return async(input,work)=>{
  const key=JSON.stringify([input.workspaceId,input.entityId]),previous=tails.get(key)??Promise.resolve();
  let unlock!:()=>void;const held=new Promise<void>(resolve=>{unlock=resolve;}),tail=previous.then(()=>held);tails.set(key,tail);
  await previous;try{return await run(input,work);}finally{unlock();if(tails.get(key)===tail)tails.delete(key);}
 };
}
