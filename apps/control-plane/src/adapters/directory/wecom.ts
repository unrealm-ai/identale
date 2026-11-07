import { DirectoryError, type DirectoryPort, type DirectoryIdentity, type DirectoryPerson, type DirectoryDepartment, type DirectoryExternalId, type DirectoryFact, type DirectoryAuthorizedScope, type DirectoryPage } from '@dentity/application';
import { DirectoryHttp, type DirectoryAdapterOptions, object, string, array, strings, unique, scopeRevision, tokenLifetime, providerFailure, markDirectoryName } from './http.js';

/** Host resolves/decrypts the traditional internal-app secret, never the intelligent bot secret. */
export interface WeComDirectoryOptions extends DirectoryAdapterOptions {
  corpId:string;
  agentId:string;
}
const origin='https://qyapi.weixin.qq.com' as const;
const unknown=<T>():DirectoryFact<T>=>({status:'unknown'});
const known=<T>(value:T):DirectoryFact<T>=>({status:'known',value});
function numericId(value:unknown,zero=false):string {
  const id=typeof value==='number'&&Number.isSafeInteger(value)?String(value):string(value);
  if(!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||String(Number(id))!==id||Number(id)<(zero?0:1))throw new DirectoryError('invalid_response');
  return id;
}
function envelope(row:Record<string,unknown>):Record<string,unknown> {
  if(row.errcode===0)return row;
  if(typeof row.errcode!=='number')throw new DirectoryError('invalid_response');
  if([40001,40014,42001,40013,40091].includes(row.errcode))throw providerFailure(row,'authentication_failed');
  if([48002,60011,60020,60021,301002,301005,301006,84014].includes(row.errcode))throw providerFailure(row,'authorization_denied');
  throw providerFailure(row,'unavailable');
}
/** Read-only internal-app directory. Bot binding and credential revision fencing belong to the host. */
export class WeComDirectoryAdapter implements DirectoryPort {
  readonly provider='wecom' as const;
  readonly capabilities={scopedQueries:true,incrementalEvents:false as const,directManager:true,dottedLineManagers:false,departmentLeaders:true};
  private readonly http:DirectoryHttp;
  private readonly options:WeComDirectoryOptions;
  private token:{value:string;expiresAt:number}|undefined;
  private verifying:Promise<DirectoryIdentity>|undefined;
  constructor(options:WeComDirectoryOptions){
    this.options={...options};string(options.corpId);numericId(options.agentId);
    if(options.appId!==options.agentId)throw new DirectoryError('invalid_response');
    this.http=new DirectoryHttp(options);
  }
  async verify():Promise<DirectoryIdentity>{
    if(this.verifying)return structuredClone(await this.verifying);
    this.token=undefined;
    const verification=this.authenticate();this.verifying=verification;
    try{return structuredClone(await verification);}finally{if(this.verifying===verification)this.verifying=undefined;}
  }
  private async authenticate():Promise<DirectoryIdentity>{
    const params=new URLSearchParams({corpid:this.options.corpId,corpsecret:this.options.appSecret});
    const response=envelope(await this.http.request(origin,`/cgi-bin/gettoken?${params}`,'GET',undefined,{},true));
    const value=string(response.access_token),lifetime=tokenLifetime(response.expires_in);
    // Successful gettoken binds the supplied corp; agent/get proves this secret's actual application.
    const agent=await this.raw('/cgi-bin/agent/get',{agentid:this.options.agentId},value);
    this.checkAgent(agent);
    this.token={value,expiresAt:this.http.now()+lifetime-Math.min(30000,lifetime/10)};
    return {tenantId:this.options.corpId,tenantIdNamespace:'corp_id',appId:this.options.agentId};
  }
  private checkAgent(row:Record<string,unknown>):void{
    if(numericId(row.agentid)!==this.options.agentId){this.token=undefined;throw new DirectoryError('authorization_denied');}
    if(row.close===1){this.token=undefined;throw new DirectoryError('authorization_denied');}
    if(row.close!==0)throw new DirectoryError('invalid_response');
  }
  private async raw(path:string,query:Record<string,string>,token:string):Promise<Record<string,unknown>>{
    return envelope(await this.http.request(origin,`${path}?${new URLSearchParams({...query,access_token:token})}`,'GET'));
  }
  private async request(path:string,query:Record<string,string>):Promise<Record<string,unknown>>{
    if(this.verifying)await this.verifying;
    if(!this.token||this.token.expiresAt<=this.http.now())await this.verify();
    const token=this.token!;
    try{return await this.raw(path,query,token.value);}catch(error){
      // Do not replay in-flight authorization on a stale token. The next call re-verifies the app.
      if(error instanceof DirectoryError&&['authentication_failed','authorization_denied'].includes(error.code)&&this.token===token)this.token=undefined;
      throw error;
    }
  }
  private userId(value:unknown):DirectoryExternalId{return {id:string(value),namespace:'user_id'};}
  async getAuthorizedScope():Promise<DirectoryAuthorizedScope>{
    const row=await this.request('/cgi-bin/agent/get',{agentid:this.options.agentId});this.checkAgent(row);
    const users=array(object(row.allow_userinfos).user).map(item=>this.userId(object(item).userid));
    const departments=array(object(row.allow_partys).partyid).map(id=>numericId(id));
    const tags=array(object(row.allow_tags).tagid).map(id=>numericId(id));
    if(tags.length)throw new DirectoryError('unsupported');
    if(users.length+departments.length>10000)throw new DirectoryError('limit_exceeded');
    // Root department is still a scoped department, not an invented entire-organization flag.
    return scopeRevision(departments,users,false);
  }
  async getDepartment(id:string):Promise<DirectoryDepartment>{
    numericId(id);const row=object((await this.request('/cgi-bin/department/get',{id})).department);
    const department=this.department(row);if(department.id!==id)throw new DirectoryError('invalid_response');return department;
  }
  async listChildDepartments(parentId:string,cursor?:string):Promise<DirectoryPage<DirectoryDepartment>>{
    if(cursor!==undefined)throw new DirectoryError('invalid_response');numericId(parentId);
    const rows=array((await this.request('/cgi-bin/department/simplelist',{id:parentId})).department_id);
    if(rows.length>10000)throw new DirectoryError('limit_exceeded');
    const ids=rows.map(value=>{const row=object(value);return {id:numericId(row.id),parentId:numericId(row.parentid,true)};});
    if(new Set(ids.map(row=>row.id)).size!==ids.length)throw new DirectoryError('invalid_response');
    // Upstream returns the selected subtree, not just immediate children, and supplies no names.
    const children=ids.filter(row=>row.parentId===parentId&&row.id!==parentId);
    if(children.length>Math.min(this.http.maxScopePages,60))throw new DirectoryError('limit_exceeded');
    const items:DirectoryDepartment[]=[];
    for(const child of children){const item=await this.getDepartment(child.id);if(item.parentId.status!=='known'||item.parentId.value!==parentId)throw new DirectoryError('invalid_response');items.push(item);}
    return {items,exhausted:true};
  }
  async listDepartmentMembers(departmentId:string,cursor?:string):Promise<DirectoryPage<DirectoryPerson>>{
    if(cursor!==undefined)throw new DirectoryError('invalid_response');numericId(departmentId);
    const rows=array((await this.request('/cgi-bin/user/simplelist',{department_id:departmentId,fetch_child:'0'})).userlist);
    if(rows.length>10000)throw new DirectoryError('limit_exceeded');
    const items=rows.map(row=>this.person(object(row),departmentId,true));
    if(new Set(items.map(item=>item.id.id.toLowerCase())).size!==items.length)throw new DirectoryError('invalid_response');
    return {items,exhausted:true};
  }
  async getUser(id:DirectoryExternalId):Promise<DirectoryPerson>{
    if(id.namespace!=='user_id'||id.applicationId!==undefined)throw new DirectoryError('authorization_denied');string(id.id);
    const person=this.person(await this.request('/cgi-bin/user/get',{userid:id.id}));
    if(person.id.id.toLowerCase()!==id.id.toLowerCase())throw new DirectoryError('invalid_response');return person;
  }
  private department(row:Record<string,unknown>):DirectoryDepartment{
    const id=numericId(row.id),parent=row.parentid===undefined?undefined:numericId(row.parentid,true);
    if(parent===id)throw new DirectoryError('invalid_response');
    return {id,namespace:'department_id',displayName:string(row.name),parentId:parent===undefined?unknown():known(parent==='0'?null:parent),
      leaders:row.department_leader===undefined?unknown():known(strings(row.department_leader).map(id=>this.userId(id)))};
  }
  private person(row:Record<string,unknown>,listedDepartmentId?:string,simple=false):DirectoryPerson{
    const id=this.userId(row.userid),departmentMembershipsKnown=row.department!==undefined;
    const departmentIds=departmentMembershipsKnown?array(row.department).map(value=>numericId(value)):listedDepartmentId?[listedDepartmentId]:[];
    if(listedDepartmentId&&departmentMembershipsKnown&&!departmentIds.includes(listedDepartmentId))throw new DirectoryError('invalid_response');
    let primaryDepartmentId:DirectoryFact<string|null>=unknown(),directManager:DirectoryFact<DirectoryExternalId|null>=unknown();
    if(!simple&&row.main_department!==undefined){const primary=numericId(row.main_department);if(departmentMembershipsKnown&&!departmentIds.includes(primary))throw new DirectoryError('invalid_response');primaryDepartmentId=known(primary);}
    if(!simple&&row.direct_leader!==undefined){const leaders=strings(row.direct_leader);directManager=leaders.length>1?unknown():known(leaders.length?this.userId(leaders[0]):null);}
    const status:DirectoryPerson['status']=simple?'unknown':row.status===1?'active':[2,4,5].includes(Number(row.status))&&typeof row.status==='number'?'inactive':'unknown';
    // Name may be withheld by provider permissions; use the ID as a label, never fabricate a name.
    return markDirectoryName({id,displayName:row.name===undefined?id.id:string(row.name),status,departmentIds:unique(departmentIds),departmentMembershipsKnown,primaryDepartmentId,directManager,dottedLineManagers:unknown(),aliases:[]},row.name!==undefined);
  }
}
