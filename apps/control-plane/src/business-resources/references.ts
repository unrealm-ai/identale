import type {ChannelMessageEvent,NormalizedMessageContent,SharedMessageAsset} from '@dentity/application';
/** Recognizes explicit identifiers only, never searches, follows redirects, or fetches the supplied URL. */
export function explicitResource(provider:string,value:string):SharedMessageAsset|undefined {
 const typed=/^(feishu|dingtalk|wecom):(document|minutes|meeting):([a-zA-Z0-9_-]{1,256})$/.exec(value);
 if(typed){if(typed[1]!==provider)return;return{kind:typed[2]==='document'?'file':'meeting',businessResource:{kind:typed[2] as 'document'|'minutes'|'meeting',externalId:typed[3]!}};}
 let url:URL;try{url=new URL(value);}catch{return;}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||[...url.searchParams].some(([key,value])=>key!=='from'||value!=='from_copylink'))return;
 // Feishu typed URLs have a documented stable namespace. Other provider URL shapes are not guessed.
 if(provider!=='feishu'||!['feishu.cn','larksuite.com','larkoffice.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))return;
 const ref=/^\/(docx|minutes)\/([a-zA-Z0-9_-]{1,256})\/?$/.exec(url.pathname);if(!ref)return;
 return{kind:ref[1]==='docx'?'file':'meeting',businessResource:{kind:ref[1]==='docx'?'document':'minutes',externalId:ref[2]!}};
}
export function withExplicitResources(provider:string,event:ChannelMessageEvent):ChannelMessageEvent {
 const content:NormalizedMessageContent=event.message.content??{kind:'text',blocks:[[{type:'text',text:event.message.text,styles:[]}]],coverage:'complete',warnings:[]};
 const seen=new Set<string>(),extra:SharedMessageAsset[]=[];
 for(const block of content.blocks)for(const node of block){
  if(node.type==='asset'&&node.asset.businessResource)seen.add(JSON.stringify(node.asset.businessResource));
  const values=node.type==='link'?[node.href]:node.type==='text'||node.type==='markdown'?node.text.match(/https:\/\/[^\s<>"'\[\]()]+|(?:feishu|dingtalk|wecom):(?:document|minutes|meeting):[a-zA-Z0-9_-]+/g)??[]:[];
  for(const value of values){if(extra.length>=20)break;const asset=explicitResource(provider,value);if(!asset)continue;const key=JSON.stringify(asset.businessResource);if(seen.has(key))continue;seen.add(key);extra.push(asset);}
 }
 if(!extra.length)return event;
 return{...event,message:{...event.message,content:{...content,blocks:[...content.blocks,...extra.map(asset=>[{type:'asset' as const,asset}])]}}};
}
