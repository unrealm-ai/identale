import {createHash,randomUUID} from 'node:crypto';
import {DirectoryError,type DirectoryPort,type DirectoryAuthorizedScope} from '@dentity/application';
import type {Store} from '../store.js';
import {DirectoryCredentialVault,type SealedDirectoryCredential} from '../directory/secrets.js';
import {createDirectoryAdapter} from '../adapters/directory/index.js';
import type {EmployeeChannelOptions} from './types.js';
import {validateDirectory,type ChannelValidation} from './validation.js';

export interface SharedDirectoryCredential {
 id:string;workspaceId:string;provider:'wecom';label:string;corpId:string;agentId:string;
 credential:SealedDirectoryCredential;credentialRevision:number;scopeRevision:string;stateVersion:number;
 status:'verified'|'invalid';lastError:string|null;lastVerifiedAt:number;
 createdBy:string;updatedBy:string;createdAt:number;updatedAt:number;
 validation?:ChannelValidation;
}
export const createSharedDirectorySchema=(store:Store)=>store.db.exec(`CREATE TABLE IF NOT EXISTS employee_channel_directory_credentials(
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),provider TEXT NOT NULL,
 corp_id TEXT NOT NULL,agent_id TEXT NOT NULL,state_version INTEGER NOT NULL,record_json TEXT NOT NULL,
 UNIQUE(workspace_id,provider,corp_id,agent_id));`);
/** Shared configuration only. This table never contains people or organization snapshots. */
export class EmployeeDirectoryCredentials {
 private readonly vault:DirectoryCredentialVault;
 constructor(readonly store:Store,private readonly options:EmployeeChannelOptions){this.vault=new DirectoryCredentialVault(options.masterKey);createSharedDirectorySchema(store);}
 get available(){return this.vault.available;}
 private scope(r:SharedDirectoryCredential){return['employee-shared-directory',r.workspaceId,r.id,r.corpId,r.agentId,r.credentialRevision];}
 byId(id:string):SharedDirectoryCredential|undefined{const row=this.store.one<{record_json:string}>('SELECT record_json FROM employee_channel_directory_credentials WHERE id=?',id);return row?JSON.parse(row.record_json):undefined;}
 list(workspaceId:string){return this.store.all<{record_json:string}>('SELECT record_json FROM employee_channel_directory_credentials WHERE workspace_id=?',workspaceId).map(row=>JSON.parse(row.record_json) as SharedDirectoryCredential);}
 seal(r:SharedDirectoryCredential,appSecret:string){return this.vault.seal(JSON.stringify({appSecret}),this.scope(r));}
 secret(r:SharedDirectoryCredential):string{return JSON.parse(this.vault.open(r.credential,this.scope(r))).appSecret;}
 create(workspaceId:string,actor:string,input:{label:string;corpId:string;agentId:string;appSecret:string}):SharedDirectoryCredential{const now=this.options.now?.()??Date.now();const r:SharedDirectoryCredential={id:randomUUID(),workspaceId,provider:'wecom',label:input.label,corpId:input.corpId,agentId:input.agentId,credential:{ciphertext:'',nonce:'',tag:''},credentialRevision:1,scopeRevision:'',stateVersion:0,status:'invalid',lastError:'verification_required',lastVerifiedAt:0,createdBy:actor,updatedBy:actor,createdAt:now,updatedAt:now};r.credential=this.seal(r,input.appSecret);return r;}
 save(r:SharedDirectoryCredential,old?:SharedDirectoryCredential){const next={...r,stateVersion:(old?.stateVersion??0)+1};const result=old?this.store.run('UPDATE employee_channel_directory_credentials SET corp_id=?,agent_id=?,state_version=?,record_json=? WHERE id=? AND workspace_id=? AND state_version=?',next.corpId,next.agentId,next.stateVersion,JSON.stringify(next),next.id,next.workspaceId,old.stateVersion):this.store.run('INSERT INTO employee_channel_directory_credentials(id,workspace_id,provider,corp_id,agent_id,state_version,record_json) VALUES(?,?,?,?,?,?,?)',next.id,next.workspaceId,next.provider,next.corpId,next.agentId,next.stateVersion,JSON.stringify(next));if(result.changes)r.stateVersion=next.stateVersion;return !!result.changes;}
 port(r:SharedDirectoryCredential):DirectoryPort{return createDirectoryAdapter('wecom',{appId:r.agentId,agentId:r.agentId,corpId:r.corpId,appSecret:this.secret(r),...(this.options.fetch?{fetch:this.options.fetch}:{}),...(this.options.now?{now:this.options.now}:{})});}
 async verify(r:SharedDirectoryCredential,port=this.port(r)):Promise<DirectoryAuthorizedScope>{const identity=await port.verify();if(identity.appId!==r.agentId||identity.tenantId!==r.corpId||identity.tenantIdNamespace!=='corp_id')throw new DirectoryError('authorization_denied');return port.getAuthorizedScope();}
 async verifySetup(r:SharedDirectoryCredential,port=this.port(r)){return validateDirectory(port,'wecom',undefined,this.options.now,{appId:r.agentId,tenantId:r.corpId,tenantIdNamespace:'corp_id'});}
 dto(r:SharedDirectoryCredential,referenceCount:number){return{id:r.id,label:r.label,corpId:r.corpId,agentId:r.agentId,revision:r.stateVersion,credentialRevision:r.credentialRevision,scopeRevision:r.scopeRevision,status:r.status,lastError:r.lastError,lastVerifiedAt:r.lastVerifiedAt,referenceCount,...(r.validation?{validation:r.validation}:{})};}
 impactRevision(r:SharedDirectoryCredential,refs:readonly {id:string;stateVersion:number}[]){return createHash('sha256').update(JSON.stringify([r.id,r.stateVersion,refs.map(x=>[x.id,x.stateVersion]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))] )).digest('hex');}
}
