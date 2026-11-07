import { DirectoryError, type DirectoryPort, type DirectoryIdentity, type DirectoryPerson, type DirectoryDepartment, type DirectoryExternalId, type DirectoryFact, type DirectoryAuthorizedScope, type DirectoryPage } from '@dentity/application';
import { DirectoryHttp, DirectoryCursors, type DirectoryAdapterOptions, object, string, pathId, array, strings, unique, scopeRevision, feishuEnvelope, tokenLifetime, sameIdentity,fieldFailure } from './http.js';

const unknown=<T>():DirectoryFact<T>=>({status:'unknown'});
const known=<T>(value:T):DirectoryFact<T>=>({status:'known',value});
/** Official custom-app tenant token + Contact v3. No OAuth installation or directory writes. */
export class FeishuDirectoryAdapter implements DirectoryPort {
  readonly provider='feishu' as const;
  readonly capabilities={scopedQueries:true,incrementalEvents:false as const,directManager:true,dottedLineManagers:true,departmentLeaders:true};
  private readonly http:DirectoryHttp;
  private readonly cursors=new DirectoryCursors();
  private token:{value:string;expiresAt:number}|undefined;
  private identity:DirectoryIdentity|undefined;
  private pinnedIdentity:DirectoryIdentity|undefined;
  private verifying:Promise<DirectoryIdentity>|undefined;
  constructor(private readonly options:DirectoryAdapterOptions){this.http=new DirectoryHttp(options);}
  async verify():Promise<DirectoryIdentity>{
    if(this.verifying)return structuredClone(await this.verifying);
    this.identity=undefined;this.token=undefined;
    const verification=this.authenticate();this.verifying=verification;
    try{return structuredClone(await verification);}finally{if(this.verifying===verification)this.verifying=undefined;}
  }
  private async authenticate():Promise<DirectoryIdentity>{
    const token=await this.http.request('https://open.feishu.cn','/open-apis/auth/v3/tenant_access_token/internal','POST',{app_id:this.options.appId,app_secret:this.options.appSecret},{},true);
    if(token.code!==0){feishuEnvelope(token);throw new DirectoryError('authentication_failed');}
    const value=string(token.tenant_access_token);const lifetime=tokenLifetime(token.expire);
    const data=feishuEnvelope(await this.http.request('https://open.feishu.cn','/open-apis/tenant/v2/tenant/query','GET',undefined,{authorization:`Bearer ${value}`}));
    const tenant=object(data.tenant);
    // Both fields are documented optional. display_id is NOT an event tenant_key alias.
    const tenantKey=tenant.tenant_key===undefined||tenant.tenant_key===''?undefined:string(tenant.tenant_key);
    const identity:DirectoryIdentity={tenantId:tenantKey??string(tenant.display_id),tenantIdNamespace:tenantKey?'tenant_key':'display_id',appId:this.options.appId};
    if(this.pinnedIdentity&&!sameIdentity(this.pinnedIdentity,identity))throw new DirectoryError('authorization_denied');
    this.pinnedIdentity=identity;this.identity=identity;this.token={value,expiresAt:this.http.now()+lifetime-Math.min(30000,lifetime/10)};
    return identity;
  }
  private async request(path:string):Promise<Record<string,unknown>>{
    if(!this.identity||!this.token||this.token.expiresAt<=this.http.now())await this.verify();
    try{return feishuEnvelope(await this.http.request('https://open.feishu.cn',path,'GET',undefined,{authorization:`Bearer ${this.token!.value}`}));}
    catch(error){if(error instanceof DirectoryError&&['authentication_failed','authorization_denied'].includes(error.code)){this.identity=undefined;this.token=undefined;}throw error;}
  }
  private openId(id:string):DirectoryExternalId{return {id:string(id),namespace:'open_id',applicationId:this.options.appId};}
  async getAuthorizedScope():Promise<DirectoryAuthorizedScope>{
    const departments:string[]=[];const users:DirectoryExternalId[]=[];const seen=new Set<string>();let token:string|undefined;
    let departmentsDisclosed=true,usersDisclosed=true;
    for(let page=0;page<this.http.maxScopePages;page++){
      const params=new URLSearchParams({user_id_type:'open_id',department_id_type:'open_department_id',page_size:'100'});if(token)params.set('page_token',token);
      const data=await this.request(`/open-apis/contact/v3/scopes?${params}`);
      // Unsupported group grants must not silently become a supposedly complete snapshot.
      const ids=(key:'department_ids'|'user_ids'|'group_ids')=>{
        const value=data[key];if(value===undefined)return [];
        try{return strings(value);}catch{throw fieldFailure(data,`data.${key}`,value,'array<string>');}
      };
      const groups=ids('group_ids');if(groups.length)throw fieldFailure(data,'data.group_ids',groups,'unsupported group grants','unsupported');
      departmentsDisclosed&&=data.department_ids!==undefined;usersDisclosed&&=data.user_ids!==undefined;
      departments.push(...ids('department_ids'));users.push(...ids('user_ids').map(id=>this.openId(id)));
      if(departments.length+users.length>100000)throw new DirectoryError('limit_exceeded');
      const next=this.nextToken(data,token);if(!next)return scopeRevision(departments,users,false,departmentsDisclosed&&usersDisclosed?undefined:{departments:departmentsDisclosed,users:usersDisclosed});
      if(seen.has(next))throw fieldFailure(data,'data.page_token',next,'non-repeating continuation token');seen.add(next);token=next;
    }
    throw new DirectoryError('limit_exceeded');
  }
  async getDepartment(id:string):Promise<DirectoryDepartment>{
    const params=new URLSearchParams({user_id_type:'open_id',department_id_type:'open_department_id'});
    const department=this.department(object((await this.request(`/open-apis/contact/v3/departments/${pathId(id)}?${params}`)).department));
    if(department.id!==id)throw new DirectoryError('invalid_response');return department;
  }
  async listChildDepartments(parentId:string,cursor?:string):Promise<DirectoryPage<DirectoryDepartment>>{
    string(parentId);const scope=`children:${parentId}`;const token=cursor?this.cursors.decode(scope,cursor):undefined;
    const params=new URLSearchParams({user_id_type:'open_id',department_id_type:'open_department_id',page_size:'50',fetch_child:'false'});if(token)params.set('page_token',token);
    const data=await this.request(`/open-apis/contact/v3/departments/${pathId(parentId)}/children?${params}`);
    // Contact v3 omits items on an explicitly exhausted empty children page.
    // Missing data on a continued/unknown page is not evidence of an empty tree.
    let rows:unknown[];try{rows=data.items===undefined&&data.has_more===false?[]:array(data.items);}catch{throw fieldFailure(data,'data.items',data.items,'array (may be omitted only when has_more=false)');}
    const items=rows.map(row=>this.department(object(row)));
    if(items.length>50||new Set(items.map(item=>item.id)).size!==items.length)throw new DirectoryError('invalid_response');
    for(const item of items)if(item.parentId.status==='known'&&item.parentId.value!==parentId)throw new DirectoryError('invalid_response');
    return this.page(scope,items,data,token);
  }
  async listDepartmentMembers(departmentId:string,cursor?:string):Promise<DirectoryPage<DirectoryPerson>>{
    string(departmentId);const scope=`members:${departmentId}`;const token=cursor?this.cursors.decode(scope,cursor):undefined;
    const params=new URLSearchParams({user_id_type:'open_id',department_id_type:'open_department_id',department_id:departmentId,page_size:'50'});if(token)params.set('page_token',token);
    const data=await this.request(`/open-apis/contact/v3/users/find_by_department?${params}`);
    const items=array(data.items).map(row=>this.person(object(row),departmentId));
    if(items.length>50||new Set(items.map(item=>item.id.id)).size!==items.length)throw new DirectoryError('invalid_response');
    return this.page(scope,items,data,token);
  }
  async getUser(id:DirectoryExternalId):Promise<DirectoryPerson>{
    string(id.id);
    if(!['open_id','user_id','union_id'].includes(id.namespace)||id.namespace!=='user_id'&&id.applicationId!==this.options.appId)throw new DirectoryError('authorization_denied');
    const params=new URLSearchParams({user_id_type:id.namespace,department_id_type:'open_department_id'});
    const row=object((await this.request(`/open-apis/contact/v3/users/${pathId(id.id)}?${params}`)).user);
    if(row[id.namespace]!==id.id)throw new DirectoryError('invalid_response');
    // Normalize every relationship response under open_id as well as the subject itself.
    // An alias lookup must not accidentally relabel IDs returned for another query namespace.
    const person=id.namespace==='open_id'?this.person(row):await this.getUser(this.openId(string(row.open_id)));
    if(![person.id,...person.aliases].some(alias=>alias.id===id.id&&alias.namespace===id.namespace&&alias.applicationId===id.applicationId))throw new DirectoryError('invalid_response');
    return person;
  }
  private nextToken(data:Record<string,unknown>,current?:string):string|undefined{
    if(typeof data.has_more!=='boolean')throw fieldFailure(data,'data.has_more',data.has_more,'boolean');
    if(!data.has_more)return undefined;
    let next:string;try{next=string(data.page_token);}catch{throw fieldFailure(data,'data.page_token',data.page_token,'non-empty string');}
    if(next===current)throw fieldFailure(data,'data.page_token',next,'non-repeating continuation token');return next;
  }
  private page<T>(scope:string,items:T[],data:Record<string,unknown>,current?:string):DirectoryPage<T>{const next=this.nextToken(data,current);return {items,exhausted:!next,...(next?{nextCursor:this.cursors.encode(scope,next)}:{})};}
  private department(row:Record<string,unknown>):DirectoryDepartment{
    const id=string(row.open_department_id);let leaders:DirectoryFact<readonly DirectoryExternalId[]>=unknown();
    if(row.leaders!==undefined)leaders=known(array(row.leaders).map(value=>this.openId(string(object(value).leaderID))));
    else if(row.leader_user_id!==undefined)leaders=known(row.leader_user_id===''?[]:[this.openId(string(row.leader_user_id))]);
    return {id,namespace:'open_department_id',displayName:string(row.name),parentId:row.parent_department_id===undefined?unknown():known(id==='0'&&row.parent_department_id==='0'?null:string(row.parent_department_id)),leaders};
  }
  private person(row:Record<string,unknown>,listedDepartmentId?:string):DirectoryPerson{
    const departmentMembershipsKnown=row.department_ids!==undefined;
    const departmentIds=departmentMembershipsKnown?strings(row.department_ids):listedDepartmentId?[listedDepartmentId]:[];
    if(departmentMembershipsKnown&&listedDepartmentId&&!departmentIds.includes(listedDepartmentId))throw new DirectoryError('invalid_response');
    const aliases:DirectoryExternalId[]=[];
    if(row.user_id!==undefined&&row.user_id!=='')aliases.push({id:string(row.user_id),namespace:'user_id'});
    if(row.union_id!==undefined&&row.union_id!=='')aliases.push({id:string(row.union_id),namespace:'union_id',applicationId:this.options.appId});
    let primaryDepartmentId:DirectoryFact<string|null>=unknown();
    if(row.orders!==undefined){const orders=array(row.orders).map(object);const primary=orders.filter(item=>item.is_primary_dept===true);if(primary.length>1)throw new DirectoryError('invalid_response');if(primary.length){const primaryId=string(primary[0]!.department_id);if(departmentMembershipsKnown&&!departmentIds.includes(primaryId))throw new DirectoryError('invalid_response');primaryDepartmentId=known(primaryId);}}
    let status:DirectoryPerson['status']='unknown';
    if(row.status!==undefined){const state=object(row.status);if([state.is_frozen,state.is_resigned,state.is_exited,state.is_unjoin].some(value=>value===true))status='inactive';else if(state.is_frozen===false&&state.is_resigned===false&&state.is_exited===false&&state.is_activated===true)status='active';}
    const jobTitle=typeof row.job_title==='string'?row.job_title.trim():'';
    return {id:this.openId(string(row.open_id)),displayName:string(row.name),...(jobTitle?{jobTitle}:{}),status,departmentIds:unique(departmentIds),departmentMembershipsKnown,primaryDepartmentId,
      directManager:row.leader_user_id===undefined?unknown():known(row.leader_user_id===''?null:this.openId(string(row.leader_user_id))),
      dottedLineManagers:row.dotted_line_leader_user_ids===undefined?unknown():known(strings(row.dotted_line_leader_user_ids).map(id=>this.openId(id))),aliases};
  }
}
