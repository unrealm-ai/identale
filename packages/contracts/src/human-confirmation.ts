/** Model-provided business question only. IDs, actors and routing are host/service-owned. */
export interface HumanQuestion {
 readonly questionScope:string;
 readonly decisionRequired?:boolean;
 readonly background:string;
 readonly goal:string;
 readonly knownFacts:readonly {text:string;evidenceRefs?:readonly string[]}[];
 readonly questions:readonly {id:string;text:string;required:boolean;answerType:'text'|'choice'|'boolean'|'number';constraints?:readonly string[]}[];
 readonly completionCriteria:readonly string[];
 readonly proposedAction:string;
 readonly impactScope:string;
 readonly ifNotConfirmed:string;
}
export interface HumanCheckpoint {
 readonly requestId:string;readonly contentVersion:1;readonly question:HumanQuestion;
 readonly questionDigest:string;readonly taskId:string;readonly runId:string;readonly sessionId:string;
 readonly configurationId:string;readonly inputRevision:number;readonly safe:boolean;readonly checkpointRef?:string;
}
export interface HumanContinuation {
 readonly requestId:string;readonly parentRunId:string;readonly questionDigest:string;readonly decision?:'approve'|'information'|'revise';
 readonly checkpointRef:string;readonly responseDigest:string;readonly responseText:string;
}
/** Closed, bounded schema validation, used at both trusted boundaries. */
export function validateHumanQuestion(value:unknown):HumanQuestion {
 const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const text=(v:unknown,max=4000):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max;
 const strings=(v:unknown,max=16):v is string[]=>Array.isArray(v)&&v.length<=max&&v.every(x=>text(x,2000));
 if(!obj(value)||Object.keys(value).some(k=>!['decisionRequired','questionScope','background','goal','knownFacts','questions','completionCriteria','proposedAction','impactScope','ifNotConfirmed'].includes(k))||value.decisionRequired!==undefined&&typeof value.decisionRequired!=='boolean'||!text(value.questionScope,160)||!['background','goal','proposedAction','impactScope','ifNotConfirmed'].every(k=>text(value[k]))||!strings(value.completionCriteria)||!value.completionCriteria.length||!Array.isArray(value.knownFacts)||value.knownFacts.length>20||value.knownFacts.some(x=>!obj(x)||Object.keys(x).some(k=>!['text','evidenceRefs'].includes(k))||!text(x.text)||x.evidenceRefs!==undefined&&!strings(x.evidenceRefs))||!Array.isArray(value.questions)||!value.questions.length||value.questions.length>12||value.questions.some(x=>!obj(x)||Object.keys(x).some(k=>!['id','text','required','answerType','constraints'].includes(k))||!text(x.id,80)||!text(x.text)||typeof x.required!=='boolean'||!['text','choice','boolean','number'].includes(String(x.answerType))||x.constraints!==undefined&&!strings(x.constraints))||new Set(value.questions.map(x=>(x as Record<string,unknown>).id)).size!==value.questions.length||JSON.stringify(value).length>24000)throw Error('invalid_human_question');
 return value as unknown as HumanQuestion;
}
