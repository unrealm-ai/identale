import type {DiagnosticFailure} from '@dentity/application';
/** Templates only: resource IDs and query values never leave this function. */
export function directoryOperationMetadata(input:string|URL):Pick<DiagnosticFailure,'operation'|'endpoint'|'userIdType'|'departmentIdType'|'rootDepartment'>{
 try{const u=new URL(input);if(u.hostname!=='open.feishu.cn')return{};const p=u.pathname;let operation:DiagnosticFailure['operation'],endpoint:DiagnosticFailure['endpoint'];
  if(p==='/open-apis/contact/v3/scopes'){operation='feishu.contact.scopes';endpoint='/open-apis/contact/v3/scopes';}
  else if(p==='/open-apis/contact/v3/users/find_by_department'){operation='feishu.contact.members';endpoint='/open-apis/contact/v3/users/find_by_department';}
  else if(/^\/open-apis\/contact\/v3\/users\/[^/]+$/.test(p)){operation='feishu.contact.user';endpoint='/open-apis/contact/v3/users/{userId}';}
  else if(/^\/open-apis\/contact\/v3\/departments\/[^/]+\/children$/.test(p)){operation='feishu.contact.children';endpoint='/open-apis/contact/v3/departments/{departmentId}/children';}
  else if(/^\/open-apis\/contact\/v3\/departments\/[^/]+$/.test(p)){operation='feishu.contact.department';endpoint='/open-apis/contact/v3/departments/{departmentId}';}
  if(!operation||!endpoint)return{};const user=u.searchParams.get('user_id_type'),department=u.searchParams.get('department_id_type');const rootDepartment=operation==='feishu.contact.members'?u.searchParams.get('department_id')==='0':operation==='feishu.contact.department'||operation==='feishu.contact.children'?p.split('/')[5]==='0':undefined;
  return{operation,endpoint,...(user&&['open_id','user_id','union_id'].includes(user)?{userIdType:user as 'open_id'|'user_id'|'union_id'}:{}),...(department&&['open_department_id','department_id'].includes(department)?{departmentIdType:department as 'open_department_id'|'department_id'}:{}),...(rootDepartment===undefined?{}:{rootDepartment})};
 }catch{return{};}
}
