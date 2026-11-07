import{ApiError}from'../../shared/api';
/** Retry only a definite pre-admission configuration miss, never an uncertain write or denial. */
export async function openWhenConfigured<T>(open:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal,onWaiting:()=>void,options:{timeoutMs?:number;intervalMs?:number}={}):Promise<T>{
 const deadline=Date.now()+(options.timeoutMs??60000),interval=options.intervalMs??1000;
 for(;;){signal.throwIfAborted();const remaining=deadline-Date.now();if(remaining<=0)throw new ApiError('employee_configuration_pending',503);
  try{return await open(AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,remaining))]));}
  catch(error){signal.throwIfAborted();if(!(error instanceof ApiError)||error.status!==503||error.code!=='employee_configuration_pending')throw error;const wait=Math.min(interval,deadline-Date.now());if(wait<=0)throw error;onWaiting();await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},wait);signal.addEventListener('abort',abort,{once:true});if(signal.aborted){signal.removeEventListener('abort',abort);abort();}});}
 }
}
