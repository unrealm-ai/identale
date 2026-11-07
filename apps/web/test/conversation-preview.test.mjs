import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import ts from'typescript';
const source=await readFile(new URL('../src/features/conversations/conversation-preview.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const{conversationPreview}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
for(const[name,input,expected]of[
 ['empty',null,''],['whitespace',' \n\t ',''],
 ['headings lists quote links','## 本周进展\r\n> **重点**\n- [需求](https://example.invalid "说明")\n1. 下一步','本周进展 重点 需求 下一步'],
 ['inline code and identifiers','Use `snake_case` and a_b; *emphasis*; _word_; ~~old~~','Use snake_case and a_b; emphasis; word; old'],
 ['fenced code','```ts\nconst count = 1;\n```\n继续','const count = 1; 继续'],
 ['image references and task list','![流程图](https://example.invalid/image.png)\n- [x] 完成\n[说明][ref]\n[ref]: https://example.invalid','流程图 完成 说明'],
 ['table','| 名称 | 状态 |\n| --- | --- |\n| 资料 | 已完成 |','名称 状态 资料 已完成'],
 ['escaped punctuation','\\*原样\\* and a_b','*原样* and a_b'],
 ['plain text only','<b>内容</b> &amp; &lt;文本&gt;','内容 & <文本>'],
 ['truncated markdown target','请看 [说明](https://example.invalid/long','请看 说明'],
])test('conversation preview text: '+name,()=>assert.equal(conversationPreview(input),expected));
test('formatting preserves the original bounded source and does not impose a second character cap',()=>{const original='中文'.repeat(80);assert.equal(conversationPreview(original),original);assert.equal(original.length,160);});
