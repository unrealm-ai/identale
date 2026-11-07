import {createHash} from 'node:crypto';
import {TaskError,taskBody,taskString} from './tasks/service.js';
import type {AccountWorkspace} from './accounts/ports.js';
export interface EmployeeSummaryFact {allowWorkspaceMembers?:boolean;channelProviders?:string[];avatarPreset?:string|null;id:string;workspaceId:string;name:string;description:string;enabled:boolean;lifecycleRevision:number;executionThinkingLevel:string;interactionRuntime:string;modelName:string|null;modelEnabled:boolean;modelCredential:boolean;allow:string[];deny:string[];legacyUser:string|null;channels:number;packages:number}
export interface ConnectionSummary {directoryConnectionId?:string|null;directoryLabel?:string;id:string;entityId:string;employeeName:string;provider:string;enabled:boolean;identity:string;directory:string;inboundVerified:boolean;transport:string}
export interface WorkbenchReadPort {
 ceiling(workspaceId:string,kind:'employees'|'connections'):number;
 employees(workspaceId:string,query:string,cursor:{ceiling:number;id:string},limit:number):EmployeeSummaryFact[];
 employee(workspaceId:string,id:string):EmployeeSummaryFact|undefined;
 employeeConnections(workspaceId:string,entityId:string):ConnectionSummary[];
 connections(workspaceId:string,cursor:{ceiling:number;id:string},limit:number):ConnectionSummary[];
}
/** Membership and presentation facts only; invocation still passes the original access service. */
export class WorkbenchReadService {
 constructor(private readonly port:WorkbenchReadPort,private readonly workspace:(userId:string,workspaceId:string)=>AccountWorkspace,private readonly now:()=>number){}
 private project(row:EmployeeSummaryFact,ws:AccountWorkspace,userId:string){const {allow,deny,legacyUser,modelCredential,allowWorkspaceMembers,...entity}=row;const webAllowed=!deny.includes(ws.memberId)&&(allowWorkspaceMembers===true||(legacyUser!==null?legacyUser===userId:allow.includes(ws.memberId)));const modelReady=row.modelEnabled&&modelCredential;const reason=!row.enabled?'员工已停用':!webAllowed?'未获得 Web 使用授权':!modelReady?'尚无有效模型配置':null;return {...entity,webAllowed,modelReady,canChat:reason===null,reason,canManage:true,liveStatus:'unknown',checkedAt:this.now()};}
 summaries(userId:string,w:string,value:unknown){return this.page(userId,w,'employees',value);}
 connections(userId:string,w:string,value:unknown){return this.page(userId,w,'connections',value);}
 overview(userId:string,w:string,id:string){const ws=this.workspace(userId,w),row=this.port.employee(w,id);if(!row)throw new TaskError(404,'entity_not_found');const partialFailures:string[]=[];let connections:ConnectionSummary[]|null=null;try{connections=this.port.employeeConnections(w,id);}catch{partialFailures.push('channels');}return {employee:this.project(row,ws,userId),connections,partialFailures,checkedAt:this.now()};}
 private page(userId:string,w:string,kind:'employees'|'connections',value:unknown){const ws=this.workspace(userId,w),q=taskBody(value,['q','cursor','limit']),search=q['q']===undefined?'':taskString(q['q'],120),limit=q['limit']===undefined?25:Number(q['limit']);if(!Number.isSafeInteger(limit)||limit<1||limit>100||q['limit']!==undefined&&!/^\d+$/.test(String(q['limit'])))throw new TaskError(400,'invalid_page_limit');
 const fingerprint=createHash('sha256').update(JSON.stringify([userId,w,kind,search])).digest('hex');let cursor={ceiling:this.port.ceiling(w,kind),id:''};if(q['cursor']!==undefined){try{if(typeof q['cursor']!=='string'||q['cursor'].length>2000)throw Error();const c=JSON.parse(Buffer.from(q['cursor'],'base64url').toString());if(c.fingerprint!==fingerprint||!Number.isSafeInteger(c.ceiling)||c.ceiling<0||typeof c.id!=='string'||!c.id||c.id.length>160)throw Error();cursor=c;}catch{throw new TaskError(400,'invalid_page_cursor');}}
 const rows=kind==='employees'?this.port.employees(w,search,cursor,limit+1):this.port.connections(w,cursor,limit+1),records=rows.slice(0,limit),last=records.at(-1);return {records:kind==='employees'?(records as EmployeeSummaryFact[]).map(r=>this.project(r,ws,userId)):records,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({...cursor,id:last.id,fingerprint})).toString('base64url'):null,checkedAt:this.now(),partialFailures:[]};}
}
