export interface ApplicationResourceProvider {
 provider:string; supportedResources:string[]; appScopes:string[];
 objectAcl:'per_resource'; availability:'available'|'unknown'|'unsupported'; limitations:string[];
}
export interface BusinessResourceConfiguration {
 configured:boolean; redirectUri?:string; reason?:string; blockers?:string[];
 providers?:{provider:string;supportedResources:string[];scopes?:string[];reason?:string;blockers?:string[]}[];
 application?:{providers:ApplicationResourceProvider[]};
}
export interface MaterialRead {kind:string;state:'ready'|'pending'|'no_permission'|'not_available'|'failed'|'unknown';reason?:string}
export interface BusinessMaterial {assetId:string;kind:string;name?:string;provider:string;accessMode?:'application';reads?:MaterialRead[];authorizationState?:'authorized'|'authorization_required'|'not_checked'}
export const resourceKind=(kind:string)=>({document:'云文档',minutes:'妙记',meeting:'会议资料',content:'正文',summary:'摘要',transcript:'逐字稿'} as Record<string,string>)[kind]??kind;
