import type{HandoffUsageScope,WorkItemStatus}from'@dentity/contracts';
export const WORK_ITEM_STATUSES:readonly WorkItemStatus[]=['pending','in_progress','waiting','awaiting_acceptance','completed','canceled','failed'];
export const workItemTerminal=(state:WorkItemStatus)=>state==='completed'||state==='canceled'||state==='failed';
export function handoffPackageAllowed(scope:HandoffUsageScope|undefined,sourceEmployeeId:string):boolean{
 if(scope?.selectionMode==='all')return true;
 if(scope?.selectionMode==='allowlist')return scope.allowEmployeeIds.includes(sourceEmployeeId);
 if(scope?.selectionMode==='denylist')return !scope.denyEmployeeIds.includes(sourceEmployeeId);
 return !scope?.denyEmployeeIds.includes(sourceEmployeeId)&&(!scope||scope.mode==='all'||scope.allowEmployeeIds.includes(sourceEmployeeId));
}
/** Business evidence drives state; Task or notification success never completes an item. */
export function workItemTransitionAllowed(from:WorkItemStatus,to:WorkItemStatus):boolean{
 if(workItemTerminal(from))return from===to;
 if(to==='canceled'||to==='failed'||from===to)return true;
 return ({pending:['in_progress','waiting'],in_progress:['waiting','awaiting_acceptance'],waiting:['in_progress','awaiting_acceptance'],awaiting_acceptance:['in_progress','waiting','completed']}as Record<string,string[]>)[from]?.includes(to)??false;
}
