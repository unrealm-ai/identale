import{computed,onUnmounted,ref,watch}from'vue';
import{api,ApiError}from'../../shared/api';
export interface WorkItemBetaState{configured:{revision:number;enabled:boolean};effective:{enabled:boolean;available:boolean;appliedRevision?:number;observedRevision?:number;error?:string|null;hasItems?:boolean}}
export const workItemWorkspaceBase=(base:string)=>base.match(/^\/workspaces\/[^/]+/)?.[0]??'';
/** Display uses applied runtime state; saving a requested setting does not flip it. */
export function useWorkItemBeta(base:()=>string,onExpired?:()=>void){
 const state=ref<WorkItemBetaState>({configured:{revision:0,enabled:false},effective:{enabled:false,available:false}}),loading=ref(false);
 let generation=0,controller=new AbortController();
 async function refresh(){const workspace=workItemWorkspaceBase(base());if(!workspace)return;const current=++generation;controller.abort();controller=new AbortController();const signal=controller.signal;loading.value=true;try{const value=await api<WorkItemBetaState>(workspace+'/work-items/settings',signal);if(!value?.configured||typeof value.effective?.enabled!=='boolean'||typeof value.effective.available!=='boolean')throw Error('invalid_work_item_state');if(current===generation&&!signal.aborted)state.value=value;}catch(e){if(current===generation&&!signal.aborted){state.value={...state.value,effective:{...state.value.effective,available:false}};if(e instanceof ApiError&&e.status===401)onExpired?.();}}finally{if(current===generation)loading.value=false;}}
 const changed=()=>{void refresh();};watch(base,()=>{state.value={configured:{revision:0,enabled:false},effective:{enabled:false,available:false}};void refresh();},{immediate:true});window.addEventListener('identity:work-items-beta-changed',changed);const timer=setInterval(changed,5000);
 onUnmounted(()=>{generation++;controller.abort();clearInterval(timer);window.removeEventListener('identity:work-items-beta-changed',changed);});
 return{state,loading,refresh,readable:computed(()=>state.value.effective.available&&(state.value.effective.enabled||state.value.effective.hasItems===true)),enabled:computed(()=>state.value.effective.available&&state.value.effective.enabled),pending:computed(()=>state.value.effective.available&&(state.value.effective.appliedRevision??0)<state.value.configured.revision)};
}
