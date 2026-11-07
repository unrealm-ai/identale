/** Legacy IDs and fallback hashing stay stable for existing employees. */
export const LEGACY_EMPLOYEE_AVATAR_PRESETS=Object.freeze(Array.from({length:12},(_,i)=>`thumbs-${String(i+1).padStart(2,'0')}`));
/** Local static cn-v2 artwork. IDs are versioned; replacing art must not rewrite saved identities. */
export const PORTRAIT_EMPLOYEE_AVATAR_PRESETS=Object.freeze(Array.from({length:27},(_,i)=>`cn-v2-${String(i+1).padStart(2,'0')}`));
export const EMPLOYEE_AVATAR_PRESETS=Object.freeze([...LEGACY_EMPLOYEE_AVATAR_PRESETS,...PORTRAIT_EMPLOYEE_AVATAR_PRESETS]);
export function isEmployeeAvatarPreset(value:unknown):value is string{return typeof value==='string'&&EMPLOYEE_AVATAR_PRESETS.includes(value);}
export function resolveEmployeeAvatarPreset(preset:unknown,key:string):string{if(isEmployeeAvatarPreset(preset))return preset;return LEGACY_EMPLOYEE_AVATAR_PRESETS[Array.from(key).reduce((n,c)=>(n*31+c.codePointAt(0)!)>>>0,0)%LEGACY_EMPLOYEE_AVATAR_PRESETS.length]!;}
