import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../dist/server.js';

test('default startup requires no public domain or HTTPS assertion and exposes no HTTP callback',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ingress-no-public-host-'));
 const app=createServer({databasePath:join(dir,'isolated.sqlite'),pollIntervalMs:0});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});await app.ready();
 assert.equal((await app.inject('/healthz')).statusCode,200);
 for(const headers of [{origin:'http://127.0.0.1:3000'},{origin:'http://127.0.0.1:3000','x-forwarded-proto':'https'}]){
  const response=await app.inject({method:'POST',url:'/api/channel-callbacks/fixture',headers,payload:{challenge:'not-a-supported-route'}});assert.equal(response.statusCode,404);assert.equal(response.body.includes('not-a-supported-route'),false);
 }
});
