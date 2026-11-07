/** Presentation only: actions still use the original permission and save paths. */
export interface EmployeeUseFacts {enabled?:boolean;webAllowed?:boolean;modelReady?:boolean;canChat?:boolean;reason?:string|null;modelName?:string|null}
export function employeeRecommendation(employee:EmployeeUseFacts,canManage:boolean){
 const blockers:string[]=[];
 if(employee.enabled===false)blockers.push(canManage?'员工已停用，恢复后才能开始新对话。':'员工已停用，请联系有管理权限的成员恢复。');
 if(employee.webAllowed===false)blockers.push(canManage?'你尚未获得对话使用权，请在权限中核对授权。':'你尚未获得对话使用权，请联系有管理权限的成员为你授权。');
 if(employee.modelReady===false)blockers.push(canManage?'尚无可用模型，请在模型页面中选择模型，或到资源库添加。':'尚无可用模型，请联系有管理权限的成员配置。');
 let action:'chat'|'status'|'access'|'identity'|'refresh'|'none'='none',label='';
 if(employee.enabled===false){if(canManage){action='status';label='恢复员工';}}
 else if(employee.webAllowed===false){if(canManage){action='access';label='查看权限';}}
 else if(employee.modelReady===false){if(canManage){action='identity';label='选择模型';}}
 else if(employee.canChat===true){action='chat';label='开始对话';}
 else{blockers.push('暂时无法确认能否开始对话，请刷新后重试。');action='refresh';label='重新检查';}
 return {blockers,action,label};
}
