import type {HumanQuestion} from '@dentity/contracts';
import {humanDisplayCode} from './human-evidence.js';
const line=(text:string)=>text.replace(/\s+/g,' ').trim();
/** Presentation only. Full question/criteria/version remain in the trusted request. */
export function renderHumanNotice(requestId:string,q:HumanQuestion):string{
 const parts:string[]=[];
 const add=(text:string)=>{const value=line(text);if(value&&!parts.some(p=>p.includes(value)))parts.push(value);};
 add(q.background);
 q.questions.forEach((question,index)=>{
  const constraints=(question.constraints??[]).map(line).filter(c=>c&&!line(question.text).includes(c));
  // Choice labels are answer vocabulary, not additional user-facing instructions.
  const conditions=constraints.filter(c=>!['approve','reject','yes','no','true','false'].includes(c.toLowerCase()));
  add(`${q.questions.length>1?`${index+1}. `:''}${line(question.text)}${conditions.length?`（${conditions.join('；')}）`:''}`);
 });
 if(!parts.some(p=>p.includes(line(q.proposedAction))))add((q.decisionRequired===false?'收到答复后：':'同意后：')+q.proposedAction);
 if(!parts.some(p=>p.includes(line(q.impactScope))))add('影响：'+q.impactScope);
 return [`人工确认 ${humanDisplayCode(requestId)}`,...parts,q.decisionRequired===false?'请直接回复答案，或说明还需补充的内容。':'可回复同意、拒绝，或说明需要调整的地方。'].join('\n');
}
/** Version travels in trusted saved delivery metadata, never a model/user claim. */
export function humanNoticeVersion(requestId:string,text:string,scopeJson:string):number|null{
 try{const scope=JSON.parse(scopeJson)as{requestId?:string;contentVersion?:number};if(scope.requestId===requestId&&Number.isSafeInteger(scope.contentVersion)&&Number(scope.contentVersion)>0)return Number(scope.contentVersion);}catch{/* Old delivered notices retain their original text and legacy version evidence. */}
 const old=text.match(/\[([^\]]+)\] · v(\d+)/);return old?.[1]===requestId?Number(old[2]):null;
}
