import{createHash}from'node:crypto';
export const humanDisplayCode=(id:string)=>'H-'+createHash('sha256').update(id).digest('hex').slice(0,12).toUpperCase();
/** Clauses are generated from the immutable received message, never supplied by the model. */
export function humanEvidenceSegments(messageId:string,text:string){return [...text.matchAll(/[^，,。！？!?;；\n]+[，,。！？!?;；\n]?/gu)].flatMap(m=>{const value=m[0].trim();if(!value)return[];const start=m.index!,end=start+m[0].length;return[{id:'seg-'+createHash('sha256').update(JSON.stringify([messageId,start,end,m[0]])).digest('hex').slice(0,20),text:value,start,end}];});}
