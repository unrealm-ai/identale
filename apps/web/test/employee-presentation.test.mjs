import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ts from 'typescript';
const source=await readFile(new URL('../src/features/employees/employee-recommendation.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {employeeRecommendation}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const ready={enabled:true,webAllowed:true,modelReady:true,canChat:true};
for(const [name,facts,manage,action,reasons] of [
 ['Web-only with no optional setup',ready,true,'chat',[]],
 ['missing model',{...ready,modelReady:false,canChat:false},true,'identity',['尚无可用模型']],
 ['no usage for ordinary member with management rights',{...ready,webAllowed:false,canChat:false},true,'access',['尚未获得对话使用权']],
 ['no usage and no management rights',{...ready,webAllowed:false,canChat:false},false,'none',['联系有管理权限的成员']],
 ['disabled',{...ready,enabled:false,canChat:false},true,'status',['员工已停用']],
 ['multiple blockers',{enabled:false,webAllowed:false,modelReady:false,canChat:false},true,'status',['员工已停用','尚未获得对话使用权','尚无可用模型']],
 ['unknown facts',{},false,'refresh',['暂时无法确认']],
 ['channel presence cannot grant Web use',{...ready,webAllowed:false,canChat:false,channels:1},true,'access',['尚未获得对话使用权']],
])test('employee recommendation: '+name,()=>{const r=employeeRecommendation(facts,manage);assert.equal(r.action,action);for(const text of reasons)assert.ok(r.blockers.some(b=>b.includes(text)));if(action==='none')assert.equal(r.label,'');if(action==='chat')assert.equal(r.blockers.length,0);});
