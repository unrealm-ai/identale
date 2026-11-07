import type {ChannelMessage} from './ports.js';

export const channelLabel=(s:string)=>s.replace(/[\[\]\u0000-\u001f\u007f]/g,' ').trim().slice(0,160).trim();
/** Values are cleaned by their field renderer; omit empty generated metadata only. */
export const channelTag=(key:string,value:string)=>value.trim()?`[${key}=${value.trim()}]`:'';
const mentionToken=/@_user_[A-Za-z0-9_]+/g;
/** Resolve complete keys once. Names cannot introduce a second replacement or trusted identity. */
export function groupMentionText(message:ChannelMessage):{names:string[];text:string} {
  const mappings=new Map<string,{id:string;name:string}|null>();
  for(const mention of message.mentionDetails??[]){
    const name=typeof mention.name==='string'?channelLabel(mention.name):'';
    const next=mention.id&&name?{id:mention.id,name}:null;
    if(!mappings.has(mention.key))mappings.set(mention.key,next);
    else {const previous=mappings.get(mention.key);if(!previous||!next||previous.id!==next.id||previous.name!==next.name)mappings.set(mention.key,null);}
  }
  const names:string[]=[],seen=new Set<string>();
  for(const token of message.text.matchAll(mentionToken)){
    const value=mappings.get(token[0]);
    if(value&&!seen.has(value.id)){seen.add(value.id);names.push(value.name.replaceAll(',','，'));}
  }
  let text=message.text;
  // Only confirmed leading calls move into the header; unknown or ambiguous keys stay literal.
  while(true){const first=/^[ \t]*(@_user_[A-Za-z0-9_]+)[ \t]*/.exec(text);if(!first||!mappings.get(first[1]!))break;text=text.slice(first[0].length).trimStart();}
  text=text.replace(mentionToken,key=>{const value=mappings.get(key);return value?`@${value.name}`:key;});
  return{names,text};
}
