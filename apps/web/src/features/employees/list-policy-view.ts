export type ListSelection='all'|'allowlist'|'denylist';
export type ListPolicyView=ListSelection|'legacy';
export function listPolicyView(scope:{mode:'all'|'allowlist';selectionMode?:ListSelection},denyCount:number):ListPolicyView{
  return scope.selectionMode??(scope.mode==='allowlist'?(denyCount?'legacy':'allowlist'):denyCount?'denylist':'all');
}
export function listPolicyOptions(current:ListPolicyView,allLabel:string){return[
  {label:allLabel,value:'all'},
  {label:'允许名单（白名单，空名单无权限）',value:'allowlist'},
  {label:'拒绝名单（黑名单，空名单不额外限制）',value:'denylist'},
  ...(current==='legacy'?[{label:'历史组合策略（允许与拒绝同时生效）',value:'legacy'}]:[]),
];}
