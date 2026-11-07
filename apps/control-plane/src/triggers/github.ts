import {TriggerError,TRIGGER_BODY_LIMIT,verifyGithubSignature} from './protocol.js';
export interface GithubIssueEvent {action:string;repositoryId:number;installationId?:number;issueId:number;issueNumber:number;title:string;body:string|null;bodyHash:string;deliveryId:string}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
/** Only signed payload fields establish repository/installation scope. Sender is not a platform user. */
export function githubIssueEvent(input:{body:Uint8Array;signature:unknown;event:unknown;deliveryId:unknown;secret:string;repositoryId:number;installationId?:number}):GithubIssueEvent {
  if(!input.body.byteLength||input.body.byteLength>TRIGGER_BODY_LIMIT)throw new TriggerError(400,'invalid_trigger_body');
  const hash=verifyGithubSignature(input.secret,input.body,input.signature);
  if(input.event!=='issues'||typeof input.deliveryId!=='string'||!/^[a-fA-F0-9-]{36}$/.test(input.deliveryId))throw new TriggerError(400,'unsupported_github_event');
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.body));}catch{throw new TriggerError(400,'invalid_trigger_json');}
  if(!record(value)||typeof value.action!=='string'||!/^[a-z_]{1,32}$/.test(value.action)||!record(value.repository)||!positive(value.repository.id)||!record(value.issue)||!positive(value.issue.id)||!positive(value.issue.number)||typeof value.issue.title!=='string'||!value.issue.title.trim()||value.issue.title.length>1024||(value.issue.body!==null&&value.issue.body!==undefined&&(typeof value.issue.body!=='string'||value.issue.body.length>64000)))throw new TriggerError(400,'invalid_github_issue');
  const installationId=record(value.installation)&&positive(value.installation.id)?value.installation.id:undefined;
  if(value.repository.id!==input.repositoryId||input.installationId!==undefined&&installationId!==input.installationId)throw new TriggerError(403,'trigger_source_forbidden');
  return {action:value.action,repositoryId:value.repository.id,...(installationId!==undefined?{installationId}:{}),issueId:value.issue.id,issueNumber:value.issue.number,title:value.issue.title,body:typeof value.issue.body==='string'?value.issue.body:null,bodyHash:hash,deliveryId:input.deliveryId};
}
