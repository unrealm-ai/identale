import { DirectoryError, type DirectoryPort, type DirectoryIdentity, type DirectoryPerson, type DirectoryDepartment, type DirectoryExternalId, type DirectoryFact, type DirectoryAuthorizedScope, type DirectoryPage } from '@dentity/application';
import { DirectoryHttp, DirectoryCursors, type DirectoryAdapterOptions, object, string, array, strings, unique, scopeRevision, dingTalkEnvelope, tokenLifetime, sameIdentity } from './http.js';

export interface DingTalkDirectoryOptions extends DirectoryAdapterOptions {
  /** Host-only independent provider verification. Must never echo an unverified client corpId. */
  verifyDingTalkIdentity?:(input:{appId:string;accessToken:string})=>Promise<DirectoryIdentity>;
}
const unknown=<T>():DirectoryFact<T>=>({status:'unknown'});
const known=<T>(value:T):DirectoryFact<T>=>({status:'known',value});
function departmentId(value:unknown):string{
  const id=typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):string(value);
  if(!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||String(Number(id))!==id)throw new DirectoryError('invalid_response');return id;
}
/** Contact v2 reads use the legacy official OAPI origin; token exchange uses the current API. */
export class DingTalkDirectoryAdapter implements DirectoryPort {
  readonly provider='dingtalk' as const;
  readonly capabilities={scopedQueries:true,incrementalEvents:false as const,directManager:true,dottedLineManagers:false,departmentLeaders:true};
  private readonly http:DirectoryHttp;
  private readonly cursors=new DirectoryCursors();
  private token:{value:string;expiresAt:number}|undefined;
  private identity:DirectoryIdentity|undefined;
  private pinnedIdentity:DirectoryIdentity|undefined;
  private verifying:Promise<DirectoryIdentity>|undefined;
  constructor(private readonly options:DingTalkDirectoryOptions){this.http=new DirectoryHttp(options);}
  async verify():Promise<DirectoryIdentity>{
    if(this.verifying)return structuredClone(await this.verifying);
    this.identity=undefined;this.token=undefined;
    const verification=this.authenticate();this.verifying=verification;
    try{return structuredClone(await verification);}finally{if(this.verifying===verification)this.verifying=undefined;}
  }
  private async authenticate():Promise<DirectoryIdentity>{
    const token=await this.http.request('https://api.dingtalk.com','/v1.0/oauth2/accessToken','POST',{appKey:this.options.appId,appSecret:this.options.appSecret},{},true);
    if(token.code!==undefined)throw new DirectoryError('authentication_failed');
    const value=string(token.accessToken),lifetime=tokenLifetime(token.expireIn);
    // An internal-app token response contains no corpId. No client field can fill that gap.
    let identity:DirectoryIdentity={tenantId:this.options.appId,tenantIdNamespace:'app_id',appId:this.options.appId};
    if(this.options.verifyDingTalkIdentity){
      try{identity=await this.options.verifyDingTalkIdentity({appId:this.options.appId,accessToken:value});}catch(error){if(error instanceof DirectoryError)throw error;throw new DirectoryError('authentication_failed');}
      if(!identity||identity.appId!==this.options.appId||identity.tenantIdNamespace!=='corp_id')throw new DirectoryError('authorization_denied');
    }
    // app_id verifies only this application, not an enterprise or a cross-app tenant alias.
    string(identity.tenantId);
    if(this.pinnedIdentity&&!sameIdentity(this.pinnedIdentity,identity))throw new DirectoryError('authorization_denied');
    this.pinnedIdentity=structuredClone(identity);this.identity=structuredClone(identity);this.token={value,expiresAt:this.http.now()+lifetime-Math.min(30000,lifetime/10)};
    return this.identity;
  }
  private async request(path:string,body?:unknown):Promise<Record<string,unknown>>{
    if(!this.identity||!this.token||this.token.expiresAt<=this.http.now())await this.verify();
    const params=new URLSearchParams({access_token:this.token!.value});
    try{return dingTalkEnvelope(await this.http.request('https://oapi.dingtalk.com',`${path}?${params}`,body===undefined?'GET':'POST',body));}
    catch(error){if(error instanceof DirectoryError&&['authentication_failed','authorization_denied'].includes(error.code)){this.identity=undefined;this.token=undefined;}throw error;}
  }
  private userId(id:string):DirectoryExternalId{return {id:string(id),namespace:'user_id'};}
  async getAuthorizedScope():Promise<DirectoryAuthorizedScope>{
    const response=await this.request('/auth/scopes');const scope=object(response.auth_org_scopes);
    if(response.has_more===true||scope.has_more===true)throw new DirectoryError('invalid_response');
    const departmentIds=array(scope.authed_dept).map(departmentId);const users=strings(scope.authed_user).map(id=>this.userId(id));
    if(departmentIds.length+users.length>100000)throw new DirectoryError('limit_exceeded');
    return scopeRevision(departmentIds,users,false);
  }
  async getDepartment(id:string):Promise<DirectoryDepartment>{
    const result=object((await this.request('/topapi/v2/department/get',{dept_id:Number(departmentId(id)),language:'zh_CN'})).result);
    const department=this.department(result);if(department.id!==id)throw new DirectoryError('invalid_response');return department;
  }
  async listChildDepartments(parentId:string,cursor?:string):Promise<DirectoryPage<DirectoryDepartment>>{
    if(cursor)throw new DirectoryError('invalid_response');
    const response=await this.request('/topapi/v2/department/listsub',{dept_id:Number(departmentId(parentId)),language:'zh_CN'});
    // This official operation is not paginated. Bound its complete response instead of fabricating pages.
    const rows=array(response.result);if(rows.length>10000)throw new DirectoryError('limit_exceeded');
    const items=rows.map(row=>this.department(object(row)));
    if(new Set(items.map(item=>item.id)).size!==items.length)throw new DirectoryError('invalid_response');
    for(const item of items)if(item.parentId.status==='known'&&item.parentId.value!==parentId)throw new DirectoryError('invalid_response');
    return {items,exhausted:true};
  }
  async listDepartmentMembers(id:string,cursor?:string):Promise<DirectoryPage<DirectoryPerson>>{
    const deptId=departmentId(id),scope=`members:${deptId}`;
    const current=cursor?this.cursors.decode(scope,cursor):'0';
    if(!/^\d+$/.test(current)||!Number.isSafeInteger(Number(current)))throw new DirectoryError('invalid_response');
    const data=object((await this.request('/topapi/v2/user/list',{dept_id:Number(deptId),cursor:Number(current),size:100,order_field:'custom',language:'zh_CN'})).result);
    const items=array(data.list).map(row=>this.person(object(row),deptId));
    if(items.length>100||new Set(items.map(item=>item.id.id)).size!==items.length||typeof data.has_more!=='boolean')throw new DirectoryError('invalid_response');
    if(!data.has_more)return {items,exhausted:true};
    const next=departmentId(data.next_cursor);if(next===current)throw new DirectoryError('invalid_response');
    return {items,exhausted:false,nextCursor:this.cursors.encode(scope,next)};
  }
  async getUser(id:DirectoryExternalId):Promise<DirectoryPerson>{
    if(id.namespace!=='user_id'||id.applicationId!==undefined)throw new DirectoryError('unsupported');
    const person=this.person(object((await this.request('/topapi/v2/user/get',{userid:string(id.id),language:'zh_CN'})).result));
    if(person.id.id!==id.id)throw new DirectoryError('invalid_response');return person;
  }
  private department(row:Record<string,unknown>):DirectoryDepartment{
    const id=departmentId(row.dept_id);
    return {id,namespace:'department_id',displayName:string(row.name),
      parentId:row.parent_id===undefined?unknown():known(id==='1'&&['0','1'].includes(departmentId(row.parent_id))?null:departmentId(row.parent_id)),
      leaders:row.dept_manager_userid_list===undefined?unknown():known(strings(row.dept_manager_userid_list).map(id=>this.userId(id)))};
  }
  private person(row:Record<string,unknown>,listedDepartmentId?:string):DirectoryPerson{
    const departmentMembershipsKnown=row.dept_id_list!==undefined;
    const departmentIds=departmentMembershipsKnown?array(row.dept_id_list).map(departmentId):listedDepartmentId?[listedDepartmentId]:[];
    if(departmentMembershipsKnown&&listedDepartmentId&&!departmentIds.includes(listedDepartmentId))throw new DirectoryError('invalid_response');
    const aliases:DirectoryExternalId[]=[];
    if(row.unionid!==undefined&&row.unionid!=='')aliases.push({id:string(row.unionid),namespace:'union_id',applicationId:this.options.appId});
    // active is DingTalk activation, not a reliable employee lifecycle/offboarding status.
    const status:DirectoryPerson['status']=row.active===true?'active':'unknown';
    return {id:this.userId(string(row.userid)),displayName:string(row.name),status,departmentIds:unique(departmentIds),departmentMembershipsKnown,primaryDepartmentId:unknown(),
      directManager:row.manager_userid===undefined?unknown():known(row.manager_userid===''?null:this.userId(string(row.manager_userid))),
      dottedLineManagers:unknown(),aliases};
  }
}
