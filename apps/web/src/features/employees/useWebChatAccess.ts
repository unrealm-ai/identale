import {computed,onUnmounted,reactive,ref,watch} from 'vue';
import {api,ApiError,errorMessage} from '../../shared/api';
import type {ConfigMember} from '../../phase2';
type Policy={allowMemberIds:string[];denyMemberIds:string[];allowWorkspaceMembers?:boolean;revision:number};
export function useWebChatAccess(base:()=>string,active:()=>boolean,onSaved:()=>void,onExpired:()=>void){
  const normalize=(value:Policy):Policy=>({...value,allowWorkspaceMembers:value.allowWorkspaceMembers===true});
  const policy=ref<Policy>({allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:false,revision:0}),members=ref<ConfigMember[]>([]);
  const baseline=ref(''),loaded=ref(false),loading=ref(false),saving=ref(false),unknown=ref(false),error=ref(''),notice=ref('');
  const comparable=(p:Policy)=>JSON.stringify({allowMemberIds:p.allowMemberIds,denyMemberIds:p.denyMemberIds,allowWorkspaceMembers:p.allowWorkspaceMembers===true});
  const dirty=computed(()=>loaded.value&&comparable(policy.value)!==comparable(JSON.parse(baseline.value)));
  let controller=new AbortController(),generation=0;
  async function load(){
    if(loading.value||saving.value)return;
    const signal=controller.signal,current=generation,keep=loaded.value&&dirty.value,draft=JSON.stringify(policy.value);
    loading.value=true;error.value='';notice.value='';
    try{
      const [rawValue,people]=await Promise.all([api<Policy>(base()+'/web-access',signal),api<ConfigMember[]>(base()+'/configuration-members',signal)]);
      if(signal.aborted||current!==generation)return;
      const value=normalize(rawValue);members.value=people;baseline.value=JSON.stringify(value);loaded.value=true;
      const same=comparable(JSON.parse(draft))===comparable(value);
      if(!keep||same)policy.value=value;
      else {policy.value={...JSON.parse(draft),denyMemberIds:value.denyMemberIds,revision:value.revision};notice.value='已读取服务器配置，你的修改已保留，请核对后保存。';}
      unknown.value=false;
    }catch(cause){if(!signal.aborted&&current===generation){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)onExpired();}}
    finally{if(current===generation)loading.value=false;}
  }
  function cancel(){if(saving.value||loading.value||unknown.value||!baseline.value)return;policy.value=normalize(JSON.parse(baseline.value));error.value='';notice.value='';}
  async function save(){
    if(!loaded.value||loading.value||saving.value||unknown.value||!dirty.value)return;
    const signal=controller.signal,current=generation;
    const {revision:_revision,...body}=JSON.parse(JSON.stringify(policy.value)) as Policy;
    saving.value=true;error.value='';notice.value='';
    try{const value=normalize(await api<Policy>(base()+'/web-access',signal,body,'PUT'));if(signal.aborted||current!==generation)return;policy.value=value;baseline.value=JSON.stringify(value);notice.value='已保存。';onSaved();}
    catch(cause){if(!signal.aborted&&current===generation){unknown.value=!(cause instanceof ApiError)||cause.status>=500;error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)onExpired();}}
    finally{if(current===generation)saving.value=false;}
  }
  watch(base,()=>{generation++;controller.abort();controller=new AbortController();policy.value={allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:false,revision:0};members.value=[];baseline.value='';loaded.value=false;loading.value=false;saving.value=false;unknown.value=false;error.value='';notice.value='';},{immediate:true});
  watch(()=>[base(),active()],()=>{if(active()&&!loaded.value)void load();},{immediate:true});
  onUnmounted(()=>{generation++;controller.abort();});
  return reactive({policy,members,loaded,loading,saving,unknown,error,notice,dirty,load,save,cancel});
}
export type WebChatAccessState=ReturnType<typeof useWebChatAccess>;
