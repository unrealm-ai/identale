import type { TaskScope, TaskRow } from './service.js';
import type {TaskRequestContext} from './principal.js';
import type { TaskActivityReadPort } from './activity.js';
export interface TaskListCursor {ceiling:number;createdAt:number;id:string}
export interface TaskListQuery {status:string;limit:number;cursor:TaskListCursor}
/** Authorization is supplied by the policy adapter, not by task persistence. */
export interface TaskAuthorizationPort {
  assertActive?(scope:TaskScope):void;
  authorizeEntity(scope: TaskScope): unknown;
  /** Trusted identity/workspace/employee association only; no usage-policy or package recomputation. */
  authorizeLocal?(scope:TaskScope):void;
  refreshAuthorization?(scope:TaskScope):Promise<void>;
  /** Host-only admission receipt; never read from HTTP bodies or model tool arguments. */
  resolveForTask?(scope: TaskScope,admission?:{employeeUseAdmitted:true}): unknown|Promise<unknown>;
  validatePreparedSnapshot?(scope:TaskScope,snapshot:unknown):void;
  revalidateCurrent?(scope: TaskScope, snapshot: unknown): unknown;
  isAuthorizationError?(error: unknown): boolean;
}
/** Adapter-private retained command copies are scrubbed by their owner. */
export interface TaskContextRetentionPort { scrubContext(runId: string): void }
export interface TaskWriteResult { changes: number | bigint }
/** All transactions are synchronous: no runtime/network await may cross this boundary. */
export interface TaskRepository extends TaskActivityReadPort {
  transaction<T>(work: () => T): T;
  findScopedTask(id:string,scope:TaskRequestContext): TaskRow | undefined;
  runStatus(runId:string): {status:string} | undefined;
  operationReceipt(taskId:string,operationId:string): {receipt_json:string|null} | undefined;
  outboxStatus(taskId:string,operationId:string): {status:string} | undefined;
  inputStatus(taskId:string,revision:number): {status:string} | undefined;
  runView(runId:string): {id:string;status:string;sequence:number;result:string|null;resultInputRevision:number|null} | undefined;
  latestOperation(taskId:string): {operation_id:string} | undefined;
  findCreatedTask(scope:TaskRequestContext,operationId:string): TaskRow | undefined;
  insertPlannedTask(id:string,scope:TaskRequestContext,operationId:string,requestHash:string,input:string,contextMode:string,historyIdsJson:string,packageIdsJson:string,snapshotJson:string|null,at:number):TaskWriteResult;
  startPlannedTask(id:string,expectedVersion:number,runId:string,snapshotId:string,snapshotJson:string,expiresAt:number|null,revision:number,at:number):TaskWriteResult;
  appendPlannedInput(id:string,expectedVersion:number,revision:number,input:string,at:number):TaskWriteResult;
  replaceQueuedInput(id:string,revision:number,input:string):TaskWriteResult;
  retargetDispatch(id:string,revision:number):TaskWriteResult;
  cancelPlannedTask(id:string,expectedVersion:number,at:number):TaskWriteResult;
  taskListCeiling(scope:TaskRequestContext):number;
  listTaskPage(scope:TaskRequestContext,query:TaskListQuery):TaskRow[];
  insertTask(id:string,scope:TaskScope,conversationId:string|null,operationId:string,requestHash:string,input:string,contextMode:string,snapshotId:string,snapshotJson:string,sourceJson:string,runId:string,createdAt:number,updatedAt:number): TaskWriteResult;
  setTriggerOrigin(taskId:string,triggerId:string,eventRecordId:string,namespace:string,key:string,policyRevision:number):TaskWriteResult;
  setTaskTitle(taskId:string,title:string):TaskWriteResult;
  setTaskSnapshot(configSnapshotJson:string|null,expiresAt:number|null,taskId:string): TaskWriteResult;
  insertRun(runId:string,taskId:string,sessionId:string,createdAt:number): TaskWriteResult;
  insertInitialInput(taskId:string,revision:number,operationId:string,text:string): TaskWriteResult;
  enqueue(id:string,taskId:string,runId:string,operationId:string,kind:string,inputRevision:number): TaskWriteResult;
  operationHash(taskId:string,operationId:string): {request_hash:string} | undefined;
  insertInput(taskId:string,revision:number,operationId:string,text:string,status:string): TaskWriteResult;
  insertOperation(taskId:string,operationId:string,kind:string,requestHash:string,receiptJson:string): TaskWriteResult;
  mutateTaskVersion(status:string,inputRevision:number,updatedAt:number,taskId:string,expectedVersion:number): TaskWriteResult;
  expiredContexts(now:number): {id:string;run_id:string;snapshot_json:string}[];
  scrubContext(snapshotJson:string,taskId:string): TaskWriteResult;
  runSession(runId:string): {session_id:string} | undefined;
  inputText(taskId:string,revision:number): {text:string} | undefined;
  todoStartFact(taskId:string,runId:string):{operationId:string;inputRevision:number}|undefined;
  recoverExpiredLeases(status:string,kind:string,now:number): TaskWriteResult;
  blockedAuthorizationOutbox?(now:number):{id:string;task_id:string}[];
  requeueAuthorizedOutbox?(id:string):TaskWriteResult;
  deferBlockedAuthorization?(id:string,retryAt:number):TaskWriteResult;
  pendingOutbox(now:number,kind?:'dispatch'|'input'|'cancel',restart?:boolean): {id:string;task_id:string;run_id?:string;operation_id:string;kind:'dispatch'|'input'|'cancel';input_revision:number;scan?:{key:string;epoch:number;sequence:number}}[];
  advanceOutboxScan?(token:{key:string;epoch:number;sequence:number}):void;
  claimOutbox(leaseUntil:number,leaseToken:string,id:string,at?:number): TaskWriteResult;
  leasedOutboxRevision(id:string,leaseToken:string):{input_revision:number}|undefined;
  findTask(taskId:string): TaskRow | undefined;
  supersedeOutbox(id:string): TaskWriteResult;
  renewOutboxLease(leaseUntil:number,id:string,leaseToken:string): TaskWriteResult;
  blockUnavailableOutbox(id:string,leaseToken:string): TaskWriteResult;
  recordUnappliedInput(taskId:string,revision:number): TaskWriteResult;
  ownsOutboxLease(id:string,leaseToken:string): {id:string} | undefined;
  completeOutbox(status:string,lastError:string|null,id:string): TaskWriteResult;
  acknowledgeRunDispatch(status:string,runId:string,at?:number): TaskWriteResult;
  acknowledgeTaskDispatch(status:string,updatedAt:number,taskId:string): TaskWriteResult;
  setInputStatus(status:string,taskId:string,revision:number): TaskWriteResult;
  /** Called only within a validated Runtime-event transaction; fences any stale sender. */
  confirmInputDelivery(taskId:string,runId:string,revision:number):TaskWriteResult;
  retryOutbox(status:string,retryAt:number,lastError:string,id:string): TaskWriteResult;
  markRunUnknown(runId:string): TaskWriteResult;
  activeTasks(): TaskRow[];
  runSequence(runId:string): {sequence:number} | undefined;
  runResult(runId:string): {status:string;result_revision:number|null;result:string|null} | undefined;
  waitForInput(updatedAt:number,taskId:string): TaskWriteResult;
  taskStatus(taskId:string): {status:string} | undefined;
  setRunStatus(status:string,runId:string,at?:number): TaskWriteResult;
  setTaskStatus(status:string,updatedAt:number,taskId:string): TaskWriteResult;
  runEventState(runId:string): {task_id:string;sequence:number;status:string} | undefined;
  findEvent(runId:string,eventId:string): {id:number} | undefined;
  findInputRevision(taskId:string,revision:number): {revision:number} | undefined;
  insertUpdate(taskId:string,runId:string,eventId:string,sequence:number,type:string,payloadJson:string,createdAt:number): TaskWriteResult;
  setRunSequence(sequence:number,runId:string): TaskWriteResult;
  markRunSucceeded(runId:string,at?:number): TaskWriteResult;
  setUnappliedInputStatus(status:string,taskId:string,revision:number): TaskWriteResult;
  setRunResult(result:string,inputRevision:number,runId:string,maximumRevision:number): TaskWriteResult;
  markInputApplied(taskId:string,revision:number): TaskWriteResult;
  insertDelivery(id:string,taskId:string,conversationId:string,eventId:string,text:string,createdAt:number): TaskWriteResult;
  listTasks(scope:TaskRequestContext): TaskRow[];
  listConversationTasks(scope:TaskScope,conversationId:string):TaskRow[];
  listUpdates(taskId:string): {id:number;payload_json:string}[];
  listInputs(taskId:string): {revision:number;status:string}[];
  listDeliveries(taskId:string): {id:string;eventId:string;text:string;status:string;createdAt:number}[];
  findMutationTask(operationId:string,scope:TaskRequestContext): {task_id:string} | undefined;
}

/** Reads retained, authorized conversation history without owning its storage. */
export interface TaskConversationReadPort {
  findConversation(id:string,scope:TaskScope,now:number): {id:string} | undefined;
  conversationMode(conversationId:string): {mode:string} | undefined;
  findHistoryMessage(id:string,conversationId:string,now:number): {id:string;role:string;text:string;expiresAt:number} | undefined;
}
