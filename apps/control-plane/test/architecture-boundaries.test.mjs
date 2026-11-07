import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

const source = new URL('../../../packages/application/src/', import.meta.url);
async function sources(directory) {
  const result=[];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const url=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
    if(entry.isDirectory()) result.push(...await sources(url));
    else if(entry.name.endsWith('.ts')) result.push([url,await readFile(url,'utf8')]);
  }
  return result;
}
test('application services cannot depend on HTTP, SQLite or runtime implementation adapters',async()=>{
  for(const [file,text] of await sources(source)) {
    assert.doesNotMatch(text,/from\s+['"](?:fastify|@fastify\/[^'"]+|node:sqlite|argon2|@dentity\/runtime-builtin|[^'"]*apps\/)["']/u,String(file));
    assert.doesNotMatch(text,/\b(?:SELECT\s+.+\s+FROM|INSERT\s+(?:OR\s+IGNORE\s+)?INTO|UPDATE\s+\w+\s+SET|CREATE\s+TABLE)\b/iu,String(file));
  }
});
test('HTTP entry modules do not own persistence, runtime construction or scheduling',async()=>{
  for(const name of ['accounts','tasks','interaction-routes']) {
    const text=await readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8');
    assert.doesNotMatch(text,/\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|setInterval|new\s+(?:Store|TaskService|BuiltinInteractionRuntime|HttpTaskRuntime))\b/iu,name);
  }
});
test('task and conversation repositories do not read each other or runtime private tables',async()=>{
  const task=await readFile(new URL('../src/adapters/sqlite/task-repository.ts',import.meta.url),'utf8');
  assert.doesNotMatch(task,/\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:conversations|conversation_messages|conversation_message_index|entities|members|task_host_bindings|builtin_records)\b/iu);
  const conversation=await readFile(new URL('../src/adapters/sqlite/conversation-repository.ts',import.meta.url),'utf8');
  assert.doesNotMatch(conversation,/\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:tasks|runs|task_inputs|task_operations|entities|builtin_records)\b/iu);
});
