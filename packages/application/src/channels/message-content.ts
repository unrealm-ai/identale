/** Ordered content is untrusted presentation data. Authentication lives in the event envelope. */
export interface SharedMessageAsset {kind:'image'|'file'|'meeting';resourceKey?:string;name?:string;meetingNumber?:string;startAt?:string;endAt?:string;assetId?:string}
export type MessageContentNode =
 | {type:'text';text:string;styles:readonly string[]}
 | {type:'markdown';text:string}
 | {type:'link';text:string;href:string}
 | {type:'mention';id:string;text:string}
 | {type:'code';text:string;language?:string}
 | {type:'emotion';emotionType:string}
 | {type:'asset';asset:SharedMessageAsset}
 | {type:'separator'}
 | {type:'unsupported';kind:string};
export interface NormalizedMessageContent {kind:'text'|'post'|'image'|'file'|'video_chat'|'sticker';title?:string;blocks:readonly (readonly MessageContentNode[])[];coverage:'complete'|'partial';warnings:readonly string[]}
const object=(x:unknown):Record<string,unknown>=>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('invalid_message_content');return x as Record<string,unknown>;};
const string=(x:unknown)=>{if(typeof x!=='string')throw Error('invalid_message_content');return x;};
const key=(x:unknown)=>{const s=string(x);if(!s||/[\u0000-\u0020\u007f]/.test(s))throw Error('invalid_resource_key');return s;};
const safeLink=(x:unknown)=>{const value=string(x);try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?value:'';}catch{return '';}};
const optional=(x:unknown)=>typeof x==='string'?x:undefined;
/** Receives one decoded Feishu content object. Never concatenates v1 and v2. */
export function parseFeishuMessageContent(messageType:string,raw:unknown):NormalizedMessageContent|undefined {
 if(!['text','post','image','file','video_chat','sticker'].includes(messageType))return;
 const parsed=typeof raw==='string'?JSON.parse(raw):raw;let body=object(parsed);const warnings:string[]=[];
 if(messageType==='post'&&body.content===undefined&&body.content_v2===undefined){const locale=body.zh_cn??body.en_us??Object.values(body).find(v=>v&&typeof v==='object'&&!Array.isArray(v));if(locale)body=object(locale);}
 const asset=(value:SharedMessageAsset):MessageContentNode=>({type:'asset',asset:value});
 if(messageType==='text')return{kind:'text',blocks:[[{type:'text',text:string(body.text),styles:[]}]],coverage:'complete',warnings};
 if(messageType==='image')return{kind:'image',blocks:[[asset({kind:'image',resourceKey:key(body.image_key)})]],coverage:'complete',warnings};
 if(messageType==='file')return{kind:'file',blocks:[[asset({kind:'file',resourceKey:key(body.file_key),...(optional(body.file_name)?{name:string(body.file_name)}:{})})]],coverage:'complete',warnings};
 if(messageType==='video_chat')return{kind:'video_chat',...(optional(body.topic)?{title:string(body.topic)}:{}),blocks:[[asset({kind:'meeting',...(optional(body.topic)?{name:string(body.topic)}:{}),...(optional(body.meet_number)?{meetingNumber:string(body.meet_number)}:{}),...(optional(body.start_time)?{startAt:string(body.start_time)}:{}),...(optional(body.end_time)?{endAt:string(body.end_time)}:{})})]],coverage:'complete',warnings};
 if(messageType==='sticker')return{kind:'sticker',blocks:[[{type:'unsupported',kind:'sticker（暂不支持下载或视觉理解）'}]],coverage:'partial',warnings:['sticker_download_unsupported']};
 const source=body.content_v2??body.content;if(!Array.isArray(source))throw Error('invalid_post_blocks');let count=0;
 const blocks=source.map(paragraph=>{if(!Array.isArray(paragraph))throw Error('invalid_post_paragraph');return paragraph.map((rawNode):MessageContentNode=>{if(++count>10000)throw Error('post_structure_limit');const node=object(rawNode),tag=string(node.tag);
  switch(tag){
   case'text':return{type:'text',text:string(node.text),styles:Array.isArray(node.style)?node.style.filter((s):s is string=>['bold','italic','underline','lineThrough'].includes(String(s))):[]};
   case'md':return{type:'markdown',text:string(node.text)};
   case'a':{const href=safeLink(node.href);if(!href)warnings.push('unsafe_link_omitted');return{type:'link',text:optional(node.text)??'',href};}
   case'at':return{type:'mention',id:optional(node.user_id)??'',text:optional(node.user_name)??optional(node.text)??'提及用户'};
   case'img':return asset({kind:'image',resourceKey:key(node.image_key)});
   case'code_block':return{type:'code',text:string(node.text),...(optional(node.language)?{language:string(node.language)}:{})};
   case'emotion':return{type:'emotion',emotionType:string(node.emoji_type??node.type)};
   case'hr':return{type:'separator'};
   default:warnings.push('unsupported_post_node');return{type:'unsupported',kind:tag};
  }
 });});
 return{kind:'post',...(typeof body.title==='string'?{title:body.title}:{}),blocks,coverage:warnings.length?'partial':'complete',warnings};
}
export function messageAssets(content:NormalizedMessageContent):SharedMessageAsset[]{return content.blocks.flatMap(p=>p.flatMap(n=>n.type==='asset'?[n.asset]:[]));}
export function mapMessageAssets(content:NormalizedMessageContent,map:(asset:SharedMessageAsset,index:number)=>SharedMessageAsset):NormalizedMessageContent {let index=0;return{...content,blocks:content.blocks.map(p=>p.map(n=>n.type==='asset'?{...n,asset:map(n.asset,index++)}:n))};}
/** No resource keys, local paths or invented vision/meeting bodies enter model history. */
export function renderMessageContent(content:NormalizedMessageContent):string {
 const node=(n:MessageContentNode):string=>{switch(n.type){
 case'text':{let text=n.text;if(n.styles.includes('bold'))text=`**${text}**`;if(n.styles.includes('italic'))text=`_${text}_`;if(n.styles.includes('lineThrough'))text=`~~${text}~~`;if(n.styles.includes('underline'))text=`<u>${text}</u>`;return text;}
 case'markdown':return n.text;
 case'link':return n.href?`[${n.text}](${n.href})`:n.text;
 case'mention':return`@${n.text}`;
 case'code':return '\n```'+(n.language??'')+'\n'+n.text+'\n```\n';
 case'emotion':return`[表情类型=${JSON.stringify(n.emotionType)}]`;
 case'asset':return`[分享${({image:'图片',file:'文件',meeting:'会议资料'} as const)[n.asset.kind]}${n.asset.name?' 名称='+JSON.stringify(n.asset.name):''} asset_id=${n.asset.assetId??'待解析'}]`;
 case'separator':return'\n---\n';
 case'unsupported':return`[未解析内容类型=${JSON.stringify(n.kind)}]`;
 }};
 return(content.title?.trim()?'# '+content.title+'\n':'')+content.blocks.map(p=>p.map(node).join('')).join('\n');
}
