import type {AssetSourceScope} from '../assets/service.js';
import type {ResourceAuthorizationRequest} from './authorization.js';
export interface FeishuOAuthApplication {applicationId:string;clientSecret:string}
export interface BusinessOAuthConfiguration {
 /** Exact registered HTTPS callback, never derived from request Host/forwarded headers. */
 redirectUri:string;
 application(source:Readonly<AssetSourceScope>):FeishuOAuthApplication|Promise<FeishuOAuthApplication>;
 assertSource(source:Readonly<AssetSourceScope>):void|Promise<void>;
}
export function validateBusinessOAuthConfiguration(config:BusinessOAuthConfiguration){
 const uri=new URL(config.redirectUri);
 if(uri.protocol!=='https:'||uri.username||uri.password||uri.search||uri.hash||uri.pathname!=='/api/business-resources/feishu/callback')throw Error('business_oauth_redirect_invalid');
 return config;
}
/** No write, search, calendar, contact or offline/refresh scopes. */
export function resourceOAuthScopes(request:ResourceAuthorizationRequest):string[]{
 if(request.source.provider!=='feishu'||request.source.requesterNamespace!=='open_id'||!request.source.requesterId)throw Error('business_oauth_actor_unverified');
 if(request.resource.kind==='document')return ['docx:document:readonly'];
 throw Error('business_oauth_resource_unsupported');
}
