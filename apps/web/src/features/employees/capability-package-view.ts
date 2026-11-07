import type {ApprovedResource,ConfigMember} from '../../phase2';
import type {ConversationKind,DirectoryAccessRule} from '../directory/types';

/** Editor projection. New metadata is mapped to the agreed HTTP DTO at its boundary. */
export interface PackageEditorValue {
  userPolicyMode?:'inherit'|'allowlist'|'denylist';
  name:string;description:string;enabled:boolean;resourceIds:string[];
  mode:'inherit'|'restrict';allowMemberIds:string[];denyMemberIds:string[];
  directoryAccess:{allow:DirectoryAccessRule[];deny:DirectoryAccessRule[]};
  handoffUsageMode?:import('@dentity/contracts').HandoffUsageMode;handoffUsageScope?:import('@dentity/contracts').HandoffUsageScope;
  triggerUsageScope?:import('./trigger-types').TriggerScope;
  conversationKinds:ConversationKind[]|null;
}
export type PackageUserMode='inherit'|'allowlist'|'denylist'|'legacy';
export type NamedResource=ApprovedResource&{name?:string;description?:string};
export const clonePackage=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
export function emptyPackage():PackageEditorValue{return{handoffUsageMode:'inherit',name:'',description:'',enabled:true,resourceIds:[],mode:'inherit',allowMemberIds:[],denyMemberIds:[],directoryAccess:{allow:[],deny:[]},triggerUsageScope:{mode:'all',allowTriggerIds:[],denyTriggerIds:[]},conversationKinds:['private','group']};}
export type PackageInput={userPolicyMode?:'inherit'|'allowlist'|'denylist';handoffUsageMode?:import('@dentity/contracts').HandoffUsageMode;handoffUsageScope?:import('@dentity/contracts').HandoffUsageScope;triggerUsageScope?:import('./trigger-types').TriggerScope;name:string;description?:string;enabled:boolean;mode:'inherit'|'restrict';allowMemberIds:string[];denyMemberIds:string[];resourceIds:string[];directoryAccess?:{allow:DirectoryAccessRule[];deny:DirectoryAccessRule[]};conversationKinds?:ConversationKind[]};
export function packageEditor(value:PackageInput):PackageEditorValue{return{...(value.userPolicyMode?{userPolicyMode:value.userPolicyMode}:{}),...(value.handoffUsageMode?{handoffUsageMode:value.handoffUsageMode}:{}),...(value.handoffUsageScope?{handoffUsageScope:clonePackage(value.handoffUsageScope)}:{}),...(value.triggerUsageScope?{triggerUsageScope:clonePackage(value.triggerUsageScope)}:{}),name:value.name,description:value.description??'',enabled:value.enabled,mode:value.mode,resourceIds:[...value.resourceIds],allowMemberIds:[...value.allowMemberIds],denyMemberIds:[...value.denyMemberIds],directoryAccess:clonePackage(value.directoryAccess??{allow:[],deny:[]}),conversationKinds:value.conversationKinds===undefined?null:[...value.conversationKinds]};}
export function packageInput(value:PackageEditorValue):PackageInput{return{...(value.userPolicyMode?{userPolicyMode:value.userPolicyMode}:{}),...(value.handoffUsageMode?{handoffUsageMode:value.handoffUsageMode}:{}),...(value.handoffUsageScope?{handoffUsageScope:clonePackage(value.handoffUsageScope)}:{}),...(value.triggerUsageScope?{triggerUsageScope:clonePackage(value.triggerUsageScope)}:{}),name:value.name.trim(),description:value.description.trim(),enabled:value.enabled,mode:value.mode,allowMemberIds:[...value.allowMemberIds],denyMemberIds:[...value.denyMemberIds],resourceIds:[...value.resourceIds],directoryAccess:clonePackage(value.directoryAccess),...(value.conversationKinds===null?{}:{conversationKinds:[...value.conversationKinds]})};}
export function packageUserMode(value:Pick<PackageEditorValue,'userPolicyMode'|'mode'|'allowMemberIds'|'denyMemberIds'|'directoryAccess'>):PackageUserMode{
  if(value.userPolicyMode)return value.userPolicyMode;
  const allow=value.allowMemberIds.length+value.directoryAccess.allow.length,deny=value.denyMemberIds.length+value.directoryAccess.deny.length;
  if(value.mode==='inherit')return allow?'legacy':deny?'denylist':'inherit';
  return deny?'legacy':'allowlist';
}
export function policyLabel(value:Pick<PackageEditorValue,'userPolicyMode'|'mode'|'allowMemberIds'|'denyMemberIds'|'directoryAccess'>){
  const mode=packageUserMode(value),allow=value.allowMemberIds.length+value.directoryAccess.allow.length,deny=value.denyMemberIds.length+value.directoryAccess.deny.length;
  return mode==='inherit'?'继承员工使用范围':mode==='allowlist'?`允许名单 ${allow} 项${allow===0?'（无人可用）':''}`:mode==='denylist'?`继承员工范围，排除 ${deny} 项`:`历史组合策略 · 允许 ${allow} / 拒绝 ${deny} 项`;
}
export function resourceName(resource:NamedResource){return resource.name?.trim()||(resource.kind==='mcp'?resource.serverRef:resource.resourceId);}
export function selectedResources(ids:readonly string[],resources:readonly NamedResource[],kind:ApprovedResource['kind']){return resources.filter(resource=>ids.includes(resource.id)&&resource.kind===kind);}
export function memberNames(ids:readonly string[],members:readonly ConfigMember[]){return ids.map(id=>members.find(member=>member.id===id)?.displayName??`未解析成员（${id}）`);}
export const conversationLabels=(kinds:readonly ConversationKind[]|null)=>kinds===null?'沿用原会话规则（旧配置未设包级限制）':kinds.length?kinds.map(kind=>({private:'私聊',group:'群聊',meeting:'会议（历史兼容）'})[kind]).join('、'):'无适用会话（无人可用）';
