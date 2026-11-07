import {createHash} from 'node:crypto';
import {ChannelError,type NormalizedMessageContent,type MessageContentNode} from '@dentity/application';
/** Transient authenticated transport data. Never put these locators in inbox/JSONL/model content. */
export interface InboundAssetLocator {key:string;kind:'image'|'file';downloadCode?:string;url?:string;aesKey?:string}
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const bounded=(value:unknown,max=8192)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value)?value:undefined;
const text=(value:unknown)=>{if(typeof value!=='string'||Buffer.byteLength(value)>1_048_576)throw new ChannelError('invalid_request','invalid_ingress_text');return value;};
const name=(value:unknown)=>typeof value==='string'?value.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f]/g,'').slice(0,160):undefined;
export function parseBotContent(provider:'dingtalk'|'wecom',row:Record<string,unknown>):{content:NormalizedMessageContent;media:InboundAssetLocator[]}|undefined{
 const media:InboundAssetLocator[]=[],blocks:MessageContentNode[][]=[];let kind:NormalizedMessageContent['kind']='post';
 const asset=(type:'image'|'file',raw:unknown):MessageContentNode|undefined=>{const value=object(raw),locator:Omit<InboundAssetLocator,'key'>=provider==='dingtalk'?{kind:type,...(bounded(value.downloadCode)?{downloadCode:bounded(value.downloadCode)!}:{})}:{kind:type,...(bounded(value.url)?{url:bounded(value.url)!}:{}),...(bounded(value.aeskey,128)?{aesKey:bounded(value.aeskey,128)!}:{})};if(provider==='dingtalk'?!locator.downloadCode:!locator.url)return;const key=createHash('sha256').update(JSON.stringify(locator)).digest('hex');media.push({key,...locator});const filename=name(value.fileName??value.name);return{type:'asset',asset:{kind:type,resourceKey:key,...(filename?{name:filename}:{})}};};
 if(row.msgtype==='text'){kind='text';blocks.push([{type:'text',text:text(object(row.text).content),styles:[]}]);}
 else if(provider==='wecom'&&row.msgtype==='voice'){blocks.push([{type:'text',text:'[语音转写]\n'+text(object(row.voice).content),styles:[]}]);}
 else if(['image','picture','file'].includes(String(row.msgtype))){const type=row.msgtype==='file'?'file':'image';if(provider==='dingtalk'&&type==='file'&&row.conversationType!=='1')return;const node=asset(type,provider==='dingtalk'?row.content:row[type]);if(!node)return;kind=type;blocks.push([node]);}
 else if(provider==='dingtalk'&&row.msgtype==='richText'){
  const items=object(row.content).richText;if(!Array.isArray(items)||items.length>256)return;
  for(const raw of items){const item=object(raw);if(typeof item.text==='string')blocks.push([{type:'text',text:text(item.text),styles:[]}]);else if(item.type==='picture'){const node=asset('image',item);if(node)blocks.push([node]);else blocks.push([{type:'unsupported',kind:'图片资源不可用'}]);}else blocks.push([{type:'unsupported',kind:'富文本节点'}]);}
 }else if(provider==='wecom'&&row.msgtype==='mixed'){
  const items=object(row.mixed).msg_item;if(!Array.isArray(items)||items.length>256)return;
  for(const raw of items){const item=object(raw);if(item.msgtype==='text')blocks.push([{type:'text',text:text(object(item.text).content),styles:[]}]);else if(item.msgtype==='image'){const node=asset('image',item.image);if(node)blocks.push([node]);else blocks.push([{type:'unsupported',kind:'图片资源不可用'}]);}else blocks.push([{type:'unsupported',kind:'混合消息节点'}]);}
 }else return;
 // A quoted body is user-provided context, not proof of its original author/message/thread.
 if(provider==='wecom'&&row.quote){const quote=object(row.quote);if(quote.msgtype==='text'||quote.msgtype==='voice'){const value=object(quote[quote.msgtype]).content;if(typeof value==='string')blocks.push([{type:'text',text:'[用户引用的内容；原始消息身份未验证]\n'+text(value),styles:[]}]);}}
 if(!blocks.length)return;return{content:{kind,blocks,coverage:blocks.some(b=>b.some(n=>n.type==='unsupported'))?'partial':'complete',warnings:[]},media};
}
