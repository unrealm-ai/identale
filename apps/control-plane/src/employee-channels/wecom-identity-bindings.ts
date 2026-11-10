import type {Store} from '../store.js';
import type {EmployeeChannelRecord,WeComContactMapping} from './types.js';
const stores=new WeakMap<EmployeeChannelRecord,Store>();
export function identityStore(r:EmployeeChannelRecord){return stores.get(r);}
export function identityScope(r:EmployeeChannelRecord){return [r.id,r.sourceId,r.authRevision] as const;}
export function identityLookup(r:EmployeeChannelRecord,key:'user_id'|'callback_user_id',value:string):{user_id:string;callback_user_id:string;mapping_json:string|null}|undefined{
 return stores.get(r)?.one(`SELECT user_id,callback_user_id,mapping_json FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND ${key}=?`,...identityScope(r),value);
}
export function initializeIdentityBindings(store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS wecom_identity_bindings(connection_id TEXT NOT NULL,source_id TEXT NOT NULL,auth_revision INTEGER NOT NULL,user_id TEXT NOT NULL,callback_user_id TEXT NOT NULL,mapping_json TEXT,PRIMARY KEY(connection_id,source_id,auth_revision,user_id),UNIQUE(connection_id,source_id,auth_revision,callback_user_id));`);}
export function attachIdentityBindings(store:Store,r:EmployeeChannelRecord):EmployeeChannelRecord{
 if(r.provider!=='wecom')return r;stores.set(r,store);
 // Non-enumerable compatibility views: ordinary record serialization and spreads
 // stay bounded. Explicit old callers may enumerate evidence when needed.
 if(r.wecomContactIdentityRevision===r.authRevision){
  if(!Object.hasOwn(r,'wecomVerifiedContactIds'))Object.defineProperty(r,'wecomVerifiedContactIds',{configurable:true,get:()=>{const rows=store.all<{user_id:string}>('SELECT user_id FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND mapping_json IS NULL ORDER BY rowid',...identityScope(r));return rows.length?rows.map(x=>x.user_id):undefined;}});
  if(!Object.hasOwn(r,'wecomContactMappings'))Object.defineProperty(r,'wecomContactMappings',{configurable:true,get:()=>{const rows=store.all<{mapping_json:string}>('SELECT mapping_json FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND mapping_json IS NOT NULL ORDER BY rowid',...identityScope(r));return rows.length?rows.map(x=>JSON.parse(x.mapping_json) as WeComContactMapping):undefined;}});
 }
 return r;
}
export function writeIdentityBindings(store:Store,r:EmployeeChannelRecord,previous?:EmployeeChannelRecord){
 if(r.provider!=='wecom')return;
 if(previous&&(r.sourceId!==previous.sourceId||r.authRevision!==previous.authRevision||r.wecomContactIdentityRevision!==r.authRevision))store.run('DELETE FROM wecom_identity_bindings WHERE connection_id=?',r.id);
 if(r.wecomContactIdentityRevision!==r.authRevision)return;
 const delta=identityDelta(r);
 if(delta){for(const v of [...delta.exact,...delta.maps]){const user=typeof v==='string'?v:v.userId,callback=typeof v==='string'?v:v.callbackUserId,json=typeof v==='string'?null:JSON.stringify(v);const old=store.one<{callback_user_id:string;mapping_json:string|null}>('SELECT callback_user_id,mapping_json FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id=?',...identityScope(r),user);if(old&&(old.callback_user_id!==callback||old.mapping_json!==json))throw Error('wecom_identity_binding_conflict');if(!old)store.run('INSERT INTO wecom_identity_bindings VALUES(?,?,?,?,?,?)',...identityScope(r),user,callback,json);}return;}
 for(const field of ['wecomVerifiedContactIds','wecomContactMappings'] as const){
  const descriptor=Object.getOwnPropertyDescriptor(r,field);if(!descriptor||!('value'in descriptor))continue;
  const values=r[field]??[],kind=field==='wecomVerifiedContactIds';
  // Replacement is explicit only; ordinary configuration spreads omit these
  // compatibility properties and leave persistent relationships untouched.
  const wanted=new Set(values.map(v=>typeof v==='string'?v:v.userId));
  for(const row of store.all<{user_id:string}>(`SELECT user_id FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND mapping_json IS ${kind?'':'NOT '}NULL`,...identityScope(r)))if(!wanted.has(row.user_id))store.run('DELETE FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id=?',...identityScope(r),row.user_id);
  for(const v of values){const user=typeof v==='string'?v:v.userId,callback=typeof v==='string'?v:v.callbackUserId,json=typeof v==='string'?null:JSON.stringify(v);const old=store.one<{callback_user_id:string;mapping_json:string|null}>('SELECT callback_user_id,mapping_json FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id=?',...identityScope(r),user);if(old&&(old.callback_user_id!==callback||old.mapping_json!==json))throw Error('wecom_identity_binding_conflict');if(!old)store.run('INSERT INTO wecom_identity_bindings VALUES(?,?,?,?,?,?)',...identityScope(r),user,callback,json);}
 }
}
export function identityRecordJson(r:EmployeeChannelRecord){return JSON.stringify(r,(key,value)=>key==='wecomVerifiedContactIds'||key==='wecomContactMappings'?undefined:value);}
export interface IdentityDelta {exact:string[];maps:WeComContactMapping[]}
const deltas=new WeakMap<EmployeeChannelRecord,IdentityDelta>();
export function withIdentityDelta(r:EmployeeChannelRecord,delta:IdentityDelta){deltas.set(r,delta);return r;}
export function identityDelta(r:EmployeeChannelRecord){return deltas.get(r);}
