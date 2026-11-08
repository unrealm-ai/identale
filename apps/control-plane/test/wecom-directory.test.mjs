import test from 'node:test';
import assert from 'node:assert/strict';
import * as directory from '../dist/adapters/directory/index.js';

test('traditional WeCom directory adapter is not exported or constructible',()=>{
 assert.equal(directory.WeComDirectoryAdapter,undefined);
 assert.throws(()=>directory.createDirectoryAdapter('wecom',{appId:'bot',appSecret:'secret',corpId:'corp',agentId:'7'}),{code:'unsupported'});
});
