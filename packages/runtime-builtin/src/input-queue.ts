import type {InvocationRequest,InvocationInput,SessionHandle,ExecutionRef} from '@dentity/contracts';
import type {ModelMessage} from './types.js';
export interface QueuedBuiltinInput {
  id:string;binding:string;kind:'user'|'event';
  request:InvocationRequest<{session:SessionHandle;execution:ExecutionRef;input:InvocationInput;idempotencyKey:string}>;
  consume(signal:AbortSignal):Promise<readonly ModelMessage[]>;
  complete(replyId:string,outputRef:{resourceId:string;version:string},usage:{inputTokens:number;outputTokens:number},coveredTurnIds:readonly string[]):Promise<void>;
  reject(reason?:'failed'|'canceled'|'unknown'):Promise<void>;
  start():Promise<void>;
}
/** Scheduling cache only. Durable session/execution references own pending inputs. */
export class BuiltinInputQueue {
  private sessions=new Map<string,{owner:string;pending:QueuedBuiltinInput[]}>();
  private inputs=new Set<string>();
  private controllers=new Map<string,AbortController>();
  private owners=new Map<string,string>();
  private stopped=false;
  reserve(session:string,id:string){if(this.stopped||this.sessions.has(session))return false;this.sessions.set(session,{owner:id,pending:[]});this.inputs.add(id);return true;}
  busy(session:string){return this.sessions.has(session);}
  has(id:string){return this.inputs.has(id);}
  enqueue(session:string,input:QueuedBuiltinInput){const state=this.sessions.get(session);if(!state||this.stopped)throw Error('Interaction queue unavailable');state.pending.push(input);this.inputs.add(input.id);}
  controller(id:string,controller:AbortController){this.controllers.set(id,controller);}
  drain(session:string,owner:string,binding:string){const state=this.sessions.get(session),items:QueuedBuiltinInput[]=[];if(!state||state.owner!==owner)return items;while(state.pending[0]?.kind==='user'&&state.pending[0].binding===binding){const item=state.pending.shift()!;this.owners.set(item.id,owner);items.push(item);}return items;}
  done(id:string){this.inputs.delete(id);this.owners.delete(id);}
  async cancel(id:string){for(const state of this.sessions.values()){const index=state.pending.findIndex(item=>item.id===id);if(index>=0){const [item]=state.pending.splice(index,1);await item!.reject();this.done(id);return true;}}const controller=this.controllers.get(this.owners.get(id)??id);if(controller){controller.abort();return true;}return false;}
  release(session:string,id:string){const state=this.sessions.get(session);if(!state||state.owner!==id)return;this.inputs.delete(id);this.controllers.delete(id);const next=this.stopped?undefined:state.pending.shift();if(next){state.owner=next.id;void next.start().catch(async()=>{await next.reject('failed');this.release(session,next.id);});}else this.sessions.delete(session);}
  async stop(){this.stopped=true;const pending:Promise<void>[]=[];for(const state of this.sessions.values())for(const item of state.pending.splice(0))this.done(item.id);for(const controller of this.controllers.values())controller.abort();await Promise.allSettled(pending);}
}
