/** Single-process ingress decisions only. Fixed expiry; versions belong to values, never keys. */
export const ADMISSION_CACHE_TTL_MS=3600000;
interface Generation {version:number;keys:Set<string>}
export interface AdmissionDecision {allowed:boolean;reason:'allowed'|'entity_use_forbidden';generation:number;createdAt:number;expiresAt:number;binding:string}
export class AdmissionDecisionCache {
 private readonly entries=new Map<string,{group:string;value:AdmissionDecision}>();
 private readonly groups=new Map<string,Generation>();private version=0;private stopped=false;
 constructor(private readonly now:()=>number=Date.now,readonly capacity=4096,readonly groupCapacity=1024){}
 generation(group:string){if(this.stopped)return undefined;let g=this.groups.get(group);if(!g){if(this.groups.size>=this.groupCapacity)this.invalidate(this.groups.keys().next().value!);g={version:++this.version,keys:new Set()};this.groups.set(group,g);}return g.version;}
 current(group:string,generation:number){return !this.stopped&&this.groups.get(group)?.version===generation;}
 get(group:string,key:string,binding:string){const e=this.entries.get(key);if(!e)return;if(e.group!==group||!this.current(group,e.value.generation)||e.value.expiresAt<=this.now()||e.value.binding!==binding){this.remove(key);return;}return e.value;}
 put(group:string,key:string,generation:number,binding:string,allowed:boolean){if(!this.current(group,generation))return false;
  // Same fixed TTL makes insertion order suitable for bounded expiry reclamation.
  for(let i=0;i<16;i++){const first=this.entries.entries().next().value;if(!first||first[1].value.expiresAt>this.now())break;this.remove(first[0]);}
  this.remove(key);if(this.entries.size>=this.capacity)this.remove(this.entries.keys().next().value!);
  const at=this.now();this.entries.set(key,{group,value:{allowed,reason:allowed?'allowed':'entity_use_forbidden',generation,createdAt:at,expiresAt:at+ADMISSION_CACHE_TTL_MS,binding}});this.groups.get(group)!.keys.add(key);return true;
 }
 private remove(key:string){const e=this.entries.get(key);if(e)this.groups.get(e.group)?.keys.delete(key);this.entries.delete(key);}
 invalidate(group:string){const old=this.groups.get(group);if(old)for(const key of old.keys)this.entries.delete(key);this.groups.delete(group);++this.version;}
 close(){this.stopped=true;this.entries.clear();this.groups.clear();++this.version;}
 get size(){return this.entries.size;}
 get generations(){return this.groups.size;}
}
