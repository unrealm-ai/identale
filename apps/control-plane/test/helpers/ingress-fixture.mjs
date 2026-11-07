import assert from 'node:assert/strict';
/** Explicit local transport boundary. Real SDK protocol tests live separately. */
export function ingressFixture(){
 const live=new Map(),all=[];
 const factory=()=>{let entry;return{async start(session,sink){entry={session,sink,stopped:false};all.push(entry);live.set(session.connectionId,entry);sink.onStatus({state:'connected',changedAt:Date.now()});},async stop(){if(entry){entry.stopped=true;if(live.get(entry.session.connectionId)===entry)live.delete(entry.session.connectionId);}},status(){return{state:entry?.stopped?'stopped':'connected',changedAt:Date.now()};}};};
 async function current(id){for(let i=0;i<100;i++){await new Promise(r=>setImmediate(r));if(live.get(id))return live.get(id);}assert.fail('No local ingress runner for '+id);}
 async function receive(id,envelope){try{const entry=await current(id),result=await entry.sink.onEvent(envelope);return{statusCode:200,body:result};}catch(error){return{statusCode:error.code==='invalid_request'?400:403,body:error.code??error.message};}}
 return{factory,current,receive,all};
}
