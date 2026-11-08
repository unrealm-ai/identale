import type {SharedMessageAsset} from '@dentity/application';
import type {AssetReadKind,AssetSourceScope,AssetTransport,AssetUnavailable} from '../assets/service.js';
import type {BusinessResourceRef} from './authorization.js';

export interface DingTalkApplicationAssetOptions {
 accessToken:(scope:AssetSourceScope)=>Promise<string>;
 /** Host verifies the persisted connection, application, tenant and original actor. */
 assertSource:(scope:AssetSourceScope)=>void|Promise<void>;
 fetch?:typeof fetch;
 now?:()=>number;
 authorizeDerived?:(ref:BusinessResourceRef)=>Promise<boolean>;
}
class ReadFailure extends Error {
 constructor(readonly state:AssetUnavailable['state'],readonly reason:string){super(reason);}
}
const unavailable=(reason:string):never=>{throw new ReadFailure('not_available',reason);};
const schemaFailure=():never=>{throw new ReadFailure('failed','dingtalk_resource_schema_unverified');};
const transportFailure=(error:unknown):never=>{
 if(error instanceof ReadFailure)throw error;
 if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))throw new ReadFailure('pending','dingtalk_resource_timeout');
 throw new ReadFailure('failed','dingtalk_resource_network_error');
};
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))return schemaFailure();return value as Record<string,unknown>;};
const MAX_BYTES=25*1024*1024,MAX_PAGES=100;
const permissionCodes=new Set(['forbidden.accessDenied','forbidden.acrossOrg','orgAccessForbidden','unknownUserError','permissionError']);
/** Enterprise application reads only. No DWS profiles, user OAuth, URL fetching or identity fallback.
 * Protocol: official api-docblocksquery, block-data-structure, query-user-details and
 * queries-the-text-information-about-cloud-recording .md pages, checked 2026-11-08. */
export class DingTalkApplicationAssetTransport implements AssetTransport {
 constructor(private readonly options:DingTalkApplicationAssetOptions){}
 async read(scope:AssetSourceScope,descriptor:SharedMessageAsset,kind:AssetReadKind):Promise<Response|AssetUnavailable>{
  const ref=descriptor.businessResource;
  if(scope.provider!=='dingtalk'||scope.requesterNamespace!=='user_id'||!scope.requesterId)return{state:'not_available',reason:'dingtalk_operator_identity_unavailable'};
  if(!ref||!/^[a-zA-Z0-9_-]{1,256}$/.test(ref.externalId))return{state:'not_available',reason:'dingtalk_resource_reference_unverified'};
  if(!(ref.kind==='document'&&kind==='content')&&!(ref.kind==='meeting'&&kind==='transcript'))return{state:'not_available',reason:'dingtalk_resource_operation_unsupported'};
  const assertSource=async()=>{try{await this.options.assertSource(scope);}catch{throw new ReadFailure('no_permission','dingtalk_source_changed');}};
  try{
   await assertSource();
   // Pin one application token for both the authenticated staffId mapping and all resource pages.
   const token=await this.options.accessToken(scope);if(!token)throw new ReadFailure('no_permission','dingtalk_application_unavailable');
   let consumed=0;
   const request=async(url:URL,body?:unknown)=>{
    await assertSource();
    const response=await(this.options.fetch??fetch)(url,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:body===undefined?{'x-acs-dingtalk-access-token':token}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}).catch(transportFailure);
    try{await assertSource();}catch(error){await response.body?.cancel().catch(()=>{});throw error;}
    if(response.status===429){await response.body?.cancel().catch(()=>{});throw new ReadFailure('pending','dingtalk_resource_rate_limited');}
    if(response.status===408||response.status===504){await response.body?.cancel().catch(()=>{});throw new ReadFailure('pending','dingtalk_resource_timeout');}
    if(response.status>=500){await response.body?.cancel().catch(()=>{});throw new ReadFailure('pending','dingtalk_resource_service_unavailable');}
    if([401,403].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new ReadFailure('no_permission','dingtalk_resource_access_denied');}
    const reader=response.body?.getReader();if(!reader)return schemaFailure();
    const chunks:Uint8Array[]=[];
    try{for(;;){const part=await reader.read();if(part.done)break;consumed+=part.value.byteLength;if(consumed>MAX_BYTES){await reader.cancel();return unavailable('business_resource_size_limit');}chunks.push(part.value);}}catch(error){transportFailure(error);}finally{reader.releaseLock();}
    await assertSource();
    let parsed:unknown;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return schemaFailure();}
    const data=object(parsed);
    if(typeof data.code==='string'&&permissionCodes.has(data.code))throw new ReadFailure('no_permission','dingtalk_resource_access_denied');
    if(data.code==='cloudRecordNotFound')throw new ReadFailure('pending','dingtalk_cloud_record_not_ready');
    if(data.code==='docNotExist'||data.code==='invalidRequest.resource.notFound')return unavailable('dingtalk_resource_not_found');
    if(!response.ok||data.code!==undefined)throw new ReadFailure('failed','dingtalk_resource_read_failed');
    return data;
   };
   const directory=new URL('https://oapi.dingtalk.com/topapi/v2/user/get');directory.searchParams.set('access_token',token);
   const identity=await request(directory,{userid:scope.requesterId,language:'zh_CN'});
   // No equality inference across namespaces: this mapping is returned by the same tenant/app API.
   if(typeof identity.errcode!=='number'||!Number.isSafeInteger(identity.errcode))return schemaFailure();
   if(identity.errcode!==0)throw new ReadFailure('no_permission','dingtalk_operator_identity_unavailable');
   const user=object(identity.result);
   if(user.userid!==scope.requesterId||typeof user.unionid!=='string'||!user.unionid.trim()||user.unionid.length>512)throw new ReadFailure('not_available','dingtalk_operator_identity_unavailable');
   const id=encodeURIComponent(ref.externalId);
   if(ref.kind==='document'){
    const url=new URL(`https://api.dingtalk.com/v1.0/doc/suites/documents/${id}/blocks`);url.searchParams.set('operatorId',user.unionid);
    // No start/end filter: official query returns root blocks with embedded children. It has no
    // parentId/cursor contract; do not invent child requests or truncate to a first indexed slice.
    const data=await request(url),result=object(data.result);
    if(data.hasMore===true||result.hasMore===true)return unavailable('business_resource_partial_material');
    if(data.success!==true||!Array.isArray(result.data))return schemaFailure();
    let nodes=0;
    const count=(depth:number)=>{if(++nodes>100000||depth>64)return unavailable('business_resource_size_limit');};
    // Official Text is a bare {text, ...formatting}, NOT an elementType wrapper.
    // Link children are Text[] only; neither links nor images trigger additional downloads.
    const validateText=(value:unknown,depth:number)=>{
     count(depth);const text=object(value);
     if(text.elementType!==undefined||text.blockType!==undefined||text.children!==undefined||typeof text.text!=='string')return schemaFailure();
     for(const key of ['bold','italic','stike','underline'])if(text[key]!==undefined&&typeof text[key]!=='boolean')return schemaFailure();
     for(const key of ['color','highlight','fonts'])if(text[key]!==undefined&&typeof text[key]!=='string')return schemaFailure();
     if(text.sz!==undefined&&(typeof text.sz!=='number'||!Number.isFinite(text.sz)))return schemaFailure();
     return text.text;
    };
    const validateInline=(value:unknown,depth:number)=>{
     const item=object(value);if(item.blockType!==undefined)return schemaFailure();
     if(item.elementType===undefined){validateText(item,depth);return;}
     count(depth);
     if(!['sticker','image','link'].includes(String(item.elementType)))return unavailable('dingtalk_document_block_unsupported');
     const properties=object(item.properties);
     if(item.elementType==='link'){
      if(properties.href!==undefined&&typeof properties.href!=='string')return schemaFailure();
      if(!Array.isArray(item.children)||!item.children.length)return unavailable('dingtalk_document_children_unavailable');
      const texts=item.children.map(child=>validateText(child,depth+1));
      if(!texts.some(text=>text.length>0))return unavailable('dingtalk_document_children_unavailable');
     }else{
      if(item.children!==undefined)return schemaFailure();
      if(item.elementType==='sticker'&&typeof properties.code!=='string')return schemaFailure();
      if(item.elementType==='image'&&properties.src!==undefined&&typeof properties.src!=='string')return schemaFailure();
     }
    };
    const validate=(value:unknown,depth:number)=>{
     count(depth);
     const block=object(value),type=block.blockType;
     if(typeof type!=='string'||!['paragraph','heading','blockquote','callout','columns','orderedList','unorderedList','table','tableRow','tableCell'].includes(type))return unavailable('dingtalk_document_block_unsupported');
     if(['tableRow','tableCell'].includes(type))return unavailable('dingtalk_document_block_unsupported');
     const properties=object(block[type]);
     if(type==='table'){
      const rows=properties.rolSize,cols=properties.colSize,cells=properties.cells;
      if(typeof rows!=='number'||!Number.isSafeInteger(rows)||rows<0||typeof cols!=='number'||!Number.isSafeInteger(cols)||cols<0||!Array.isArray(cells)||cells.length!==rows||cells.some(row=>!Array.isArray(row)||row.length!==cols||row.some(cell=>typeof cell!=='string')))return unavailable('dingtalk_document_table_unavailable');
     }
     if(['callout','columns'].includes(type)&&!Array.isArray(block.children))return unavailable('dingtalk_document_children_unavailable');
     if(properties.text!==undefined&&typeof properties.text!=='string')return schemaFailure();
     if(block.children!==undefined){
      if(!Array.isArray(block.children))return schemaFailure();
      if(type==='table')return unavailable('dingtalk_document_block_unsupported');
      for(const child of block.children){if(['callout','columns'].includes(type))validate(child,depth+1);else validateInline(child,depth+1);}
     }
    };
    for(const block of result.data)validate(block,0);
    // Preserve the documented nested block and inline structures, not a lossy text projection.
    return Response.json({documentId:ref.externalId,blocks:result.data});
   }
   const paragraphs:Record<string,unknown>[]=[],seen=new Set<number>();let cursor:number|undefined;
   for(let page=0;page<MAX_PAGES;page++){
    const url=new URL(`https://api.dingtalk.com/v1.0/conference/videoConferences/${id}/cloudRecords/getTexts`);
    url.searchParams.set('unionId',user.unionid);url.searchParams.set('direction','0');url.searchParams.set('maxResults','200');
    if(cursor!==undefined)url.searchParams.set('nextToken',String(cursor));
    const data=await request(url);
    if(typeof data.hasMore!=='boolean'||!Array.isArray(data.paragraphList)||data.paragraphList.length>200)return schemaFailure();
    const items=data.paragraphList.map(object);
    for(const item of items){if(typeof item.paragraph!=='string')return schemaFailure();paragraphs.push(item);}
    if(!data.hasMore){if(!paragraphs.length)return{state:'pending',reason:'dingtalk_cloud_record_not_ready'};return Response.json({conferenceId:ref.externalId,paragraphs});}
    // The official response calls this nextTtoken and places it on each paragraph, whereas
    // the request parameter is nextToken. Never guess an unrelated top-level cursor.
    const next=items.at(-1)?.nextTtoken;
    if(typeof next!=='number'||!Number.isSafeInteger(next)||next<0||seen.has(next)||(cursor!==undefined&&next<=cursor))return unavailable('business_resource_partial_material');
    seen.add(next);cursor=next;
   }
   return unavailable('business_resource_page_limit');
  }catch(error){if(error instanceof ReadFailure)return{state:error.state,reason:error.reason};return{state:'failed',reason:'dingtalk_resource_read_failed'};}
 }
 async readAlternative(_scope:AssetSourceScope,_descriptor:SharedMessageAsset,_kind:AssetReadKind):Promise<AssetUnavailable>{return{state:'not_available',reason:'dingtalk_resource_operation_unsupported'};}
}
