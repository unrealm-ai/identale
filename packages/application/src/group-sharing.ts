import type{GroupSharingRule,GroupSharingSnapshot,SharingGroup,SharingDestination}from'@dentity/contracts';
export const sharingIdentityKey=(r:SharingDestination)=>JSON.stringify([r.provider,r.connectionId,r.appId,r.tenantId,r.bindingVersion]);
export const sharingTargetKey=(r:SharingDestination)=>JSON.stringify([sharingIdentityKey(r),r.kind,r.id,r.kind==='person'?r.namespace:'']);
export function sharingSources(rules:readonly GroupSharingRule[],destination:SharingDestination):GroupSharingSnapshot['sources']{
 const found=new Map<string,GroupSharingSnapshot['sources'][number]>();
 for(const rule of rules){if(!rule.enabled)continue;const targets=rule.type==='mutual'?rule.sources:rule.targets;
  if(!targets.some(t=>sharingTargetKey(t)===sharingTargetKey(destination)))continue;
  for(const group of rule.sources){if(sharingIdentityKey(group)!==sharingIdentityKey(destination)||sharingTargetKey(group)===sharingTargetKey(destination))continue;
   const key=sharingTargetKey(group),item=found.get(key)??{group,rules:[]};item.rules.push({id:rule.id,revision:rule.revision});found.set(key,item);
  }
 }return[...found.values()];
}
export function sharingAllows(snapshot:GroupSharingSnapshot,source:SharingGroup):boolean{
 return ((!snapshot.destinationThreadId||!!snapshot.topicRead&&snapshot.topicRead.threadId===snapshot.destinationThreadId&&snapshot.topicRead.chatId===snapshot.destination.id)&&sharingTargetKey(snapshot.destination)===sharingTargetKey(source))||snapshot.sources.some(s=>sharingTargetKey(s.group)===sharingTargetKey(source));
}
