import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EMPLOYEE_AVATAR_PRESETS,LEGACY_EMPLOYEE_AVATAR_PRESETS,PORTRAIT_EMPLOYEE_AVATAR_PRESETS,isEmployeeAvatarPreset,resolveEmployeeAvatarPreset} from '@dentity/contracts';
test('27 local cn-v2 WebP portraits extend rather than replace the 12 legacy IDs',async()=>{
 assert.equal(LEGACY_EMPLOYEE_AVATAR_PRESETS.length,12);assert.equal(PORTRAIT_EMPLOYEE_AVATAR_PRESETS.length,27);assert.equal(new Set(EMPLOYEE_AVATAR_PRESETS).size,39);
 for(const id of LEGACY_EMPLOYEE_AVATAR_PRESETS){assert.equal(resolveEmployeeAvatarPreset(id,'other'),id);assert.ok(isEmployeeAvatarPreset(id));await readFile(new URL(`../public/employee-avatars/${id}.svg`,import.meta.url));}
 for(const id of PORTRAIT_EMPLOYEE_AVATAR_PRESETS){assert.equal(resolveEmployeeAvatarPreset(id,'other'),id);assert.ok(isEmployeeAvatarPreset(id));const image=await readFile(new URL(`../public/employee-avatars/${id}.webp`,import.meta.url));assert.equal(image.subarray(0,4).toString(),'RIFF');assert.equal(image.subarray(8,12).toString(),'WEBP');assert.ok(image.length<50_000);}
 for(const id of ['cn-v2-28','cn-v2-00','../cn-v2-01','https://example.invalid/a.webp'])assert.equal(isEmployeeAvatarPreset(id),false);
});
test('employees without a saved preset keep the original legacy fallback across the additive catalog',()=>{
 assert.equal(resolveEmployeeAvatarPreset(null,''),'thumbs-01');assert.equal(resolveEmployeeAvatarPreset(undefined,'a'),'thumbs-02');assert.equal(resolveEmployeeAvatarPreset('not-valid','b'),'thumbs-03');
});
