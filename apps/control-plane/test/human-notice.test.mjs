import test from 'node:test';
import assert from 'node:assert/strict';
import {renderHumanNotice,humanNoticeVersion} from '../dist/human-notice.js';
const id='00000000-0000-4000-8000-000000000001';
const question={questionScope:'qa',background:'第一步已准备完成。',goal:'Internal long goal',knownFacts:[],questions:[{id:'q1_internal_field',text:'是否允许生成本地中间测试文件？',required:true,answerType:'choice',constraints:['approve','reject']}],completionCriteria:['Internal explicit version condition'],proposedAction:'生成本地中间测试文件',impactScope:'仅本地测试，不影响真实业务。',ifNotConfirmed:'Internal waiting semantics'};
test('default notice is concise, omits protocol details and avoids duplicate action text without dropping impact',()=>{
 const text=renderHumanNotice(id,question);assert.match(text,/人工确认 H-[A-F0-9]{12}/);assert.match(text,/第一步已准备完成/);assert.match(text,/是否允许生成本地中间测试文件/);assert.match(text,/仅本地测试，不影响真实业务/);assert.match(text,/同意、拒绝/);
 for(const hidden of[id,'q1_internal_field','Internal long goal','Internal explicit version condition','Internal waiting semantics','继续标准','目标：','（必答）'])assert.equal(text.includes(hidden),false,hidden);
 assert.equal(text.split('生成本地中间测试文件').length-1,1);assert.ok(Array.from(text).length<180);
});
test('multiple questions keep clear numbering, material constraints and distinct action/risk text',()=>{
 const text=renderHumanNotice(id,{...question,questions:[{...question.questions[0],text:'预算是否批准？',constraints:['总额不超过100元']},{id:'internal_two',text:'执行时间是否确定？',required:true,answerType:'text'}],proposedAction:'按明确批准的预算和时间继续',impactScope:'将产生测试费用，未明确的条件不会执行。'});
 assert.match(text,/1\. 预算是否批准？（总额不超过100元）/);assert.match(text,/2\. 执行时间是否确定？/);assert.match(text,/同意后：按明确批准的预算和时间继续/);assert.match(text,/将产生测试费用/);assert.equal(text.includes('internal_two'),false);
});
test('information-only requests ask for information without presenting a false approval instruction',()=>{
 const text=renderHumanNotice(id,{...question,decisionRequired:false,questions:[{id:'filename',text:'您希望使用什么名称？',required:true,answerType:'text'}],proposedAction:'以答复的名称生成合成测试文件'});assert.match(text,/直接回复答案/);assert.equal(text.includes('可回复同意、拒绝'),false);assert.equal(text.includes('同意后：'),false);assert.match(text,/收到答复后：/);
});
test('trusted saved delivery metadata carries hidden question version; legacy sent text remains readable and foreign metadata cannot select it',()=>{
 const text=renderHumanNotice(id,question);assert.equal(humanNoticeVersion(id,text,JSON.stringify({requestId:id,contentVersion:1})),1);assert.equal(humanNoticeVersion(id,text,JSON.stringify({requestId:'foreign',contentVersion:1})),null);assert.equal(humanNoticeVersion(id,text,JSON.stringify({requestId:id,contentVersion:0})),null);assert.equal(humanNoticeVersion(id,'请求 ['+id+'] · v2','{}'),2);assert.equal(humanNoticeVersion(id,text,'not-json'),null);
});
