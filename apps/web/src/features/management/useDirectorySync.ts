import {computed,onUnmounted,ref,watch} from 'vue';
import {api,ApiError,errorMessage} from '../../shared/api';
import type {Workspace} from '../../shared/api';
import type {SyncLoadState} from './directory-sync-view';
import {historyView,taskView,readTask,readTasks,readHistory,MIN_SYNC_PERIOD_MS,MAX_SYNC_PERIOD_MS,type DirectorySyncTask,type DirectorySyncHistory,type DirectorySyncPatch} from './directory-sync-api';

export function useDirectorySync(props:{workspace:Workspace;connectionId?:string|undefined},emit:{(event:'busyChanged',value:boolean):void;(event:'sessionExpired'):void}){
  const tasks=ref<DirectorySyncTask[]>([]),history=ref<DirectorySyncHistory[]>([]),loadState=ref<SyncLoadState>('loading'),error=ref(''),notice=ref('');
  const pendingTaskId=ref<string|null>(null),selectedTaskId=ref<string|null>(null),historyLoading=ref(false),historyError=ref(''),nextCursor=ref<string|null>(null);
  const canManage=computed(()=>['owner','admin','member'].includes(props.workspace.role));
  const taskRows=computed(()=>tasks.value.filter(task=>!props.connectionId||task.connectionId===props.connectionId||task.memberConnectionIds?.includes(props.connectionId)).map(taskView)),historyRows=computed(()=>history.value.map(historyView));
  let controller=new AbortController(),historyController=new AbortController(),generation=0,listRequest=0,historyRequest=0,poll:ReturnType<typeof setTimeout>|undefined;
  const seenCursors=new Set<string>();
  const base=()=>`/workspaces/${encodeURIComponent(props.workspace.id)}/directory-sync/tasks`;
  watch(pendingTaskId,value=>emit('busyChanged',value!==null),{flush:'sync'});
  function stopPoll(){if(poll!==undefined)clearTimeout(poll);poll=undefined;}
  function resetHistory(){historyRequest++;historyController.abort();historyController=new AbortController();selectedTaskId.value=null;history.value=[];nextCursor.value=null;historyError.value='';historyLoading.value=false;seenCursors.clear();}
  function scopeCurrent(version:number,workspaceId:string){return version===generation&&workspaceId===props.workspace.id&&!controller.signal.aborted&&canManage.value;}
  function handleError(cause:unknown){
    if(cause instanceof ApiError&&cause.status===401){tasks.value=[];resetHistory();loadState.value='denied';emit('sessionExpired');return;}
    if(cause instanceof ApiError&&cause.status===403){tasks.value=[];resetHistory();loadState.value='denied';stopPoll();error.value=errorMessage(cause);return;}
    error.value=errorMessage(cause);
  }
  function schedulePoll(){stopPoll();if(canManage.value&&loadState.value==='ready'&&tasks.value.some(t=>t.running))poll=setTimeout(()=>{poll=undefined;void refresh(false);},5000);}
  async function refresh(explicit=true){
    if(!canManage.value||pendingTaskId.value!==null)return;
    const version=generation,workspaceId=props.workspace.id,request=++listRequest,signal=controller.signal;
    stopPoll();if(explicit){loadState.value='loading';error.value='';}
    try{
      const result=readTasks(await api<unknown>(base(),signal),workspaceId);
      if(!scopeCurrent(version,workspaceId)||request!==listRequest)return;
      tasks.value=result;loadState.value='ready';error.value='';
      if(selectedTaskId.value&&!tasks.value.some(t=>t.id===selectedTaskId.value))resetHistory();
      if(selectedTaskId.value)void loadHistory(selectedTaskId.value);
      schedulePoll();
    }catch(cause){if(!scopeCurrent(version,workspaceId)||request!==listRequest)return;handleError(cause);if(loadState.value!=='denied')loadState.value='error';}
  }
  async function loadHistory(id:string,more=false){
    if(!canManage.value||pendingTaskId.value!==null||!tasks.value.some(t=>t.id===id)||more&&(historyLoading.value||id!==selectedTaskId.value||!nextCursor.value))return;
    historyController.abort();historyController=new AbortController();const signal=historyController.signal,request=++historyRequest,version=generation,workspaceId=props.workspace.id;
    if(!more){history.value=[];nextCursor.value=null;seenCursors.clear();}selectedTaskId.value=id;historyLoading.value=true;historyError.value='';
    const cursor=more?nextCursor.value:null,query=new URLSearchParams({limit:'25'});if(cursor)query.set('cursor',cursor);
    try{
      const page=readHistory(await api<unknown>(`${base()}/${encodeURIComponent(id)}/history?${query}`,signal),id);
      if(signal.aborted||!scopeCurrent(version,workspaceId)||request!==historyRequest||id!==selectedTaskId.value)return;
      if(page.nextCursor&&(page.nextCursor===cursor||seenCursors.has(page.nextCursor)))throw new Error('repeated_directory_sync_cursor');
      if(page.nextCursor)seenCursors.add(page.nextCursor);
      history.value=more?[...history.value,...page.items.filter(item=>!history.value.some(old=>old.id===item.id))]:page.items;nextCursor.value=page.nextCursor;
    }catch(cause){if(!signal.aborted&&scopeCurrent(version,workspaceId)&&request===historyRequest){if(cause instanceof ApiError&&(cause.status===401||cause.status===403))handleError(cause);else historyError.value=errorMessage(cause);}}
    finally{if(!signal.aborted&&scopeCurrent(version,workspaceId)&&request===historyRequest)historyLoading.value=false;}
  }
  async function mutate(id:string,patch?:Omit<DirectorySyncPatch,'expectedVersion'>){
    const task=tasks.value.find(t=>t.id===id);if(!task||!canManage.value||pendingTaskId.value!==null||loadState.value!=='ready'||task.lastResult==='invalidated'||!patch&&task.running)return;
    stopPoll();listRequest++;historyController.abort();historyRequest++;historyLoading.value=false;
    pendingTaskId.value=id;error.value='';notice.value='';const version=generation,workspaceId=props.workspace.id,signal=controller.signal;
    let reload=false;
    try{
      const result=await api<unknown>(`${base()}/${encodeURIComponent(id)}${patch?'':'/run'}`,signal,patch?{expectedVersion:task.version,...patch}:{},patch?'PATCH':'POST');
      if(!scopeCurrent(version,workspaceId))return;
      let updated:DirectorySyncTask;
      if(patch){updated=readTask(result,workspaceId);notice.value='同步计划已保存。暂停或启用定时同步不会改变机器人连接。';}
      else{
        if(!result||typeof result!=='object'||!('accepted'in result)||typeof result.accepted!=='boolean'||!('task'in result))throw new Error('invalid_directory_sync_acceptance');
        updated=readTask(result.task,workspaceId);notice.value=result.accepted?'已接受同步请求，请查看实际同步结果。':'此任务已有同步正在进行，未重复排队。';
      }
      if(updated.id!==id)throw new Error('unexpected_directory_sync_task');tasks.value=tasks.value.map(t=>t.id===id?updated:t);
    }catch(cause){
      if(!scopeCurrent(version,workspaceId))return;
      handleError(cause);
      if(!(cause instanceof ApiError&&[401,403].includes(cause.status))){
        reload=true;
        notice.value=cause instanceof ApiError&&cause.status===409?'同步计划已被其他操作更新，正在读取最新版本；未自动重试保存。':cause instanceof ApiError&&cause.status===404?'任务或连接已变化，正在重新读取当前工作区列表。':cause instanceof ApiError&&cause.status<500?'请求被拒绝，请核对输入和当前状态；未自动重试。':'操作结果尚未确认。请刷新状态和记录核对；未自动重复保存或同步。';
      }
    }finally{
      if(scopeCurrent(version,workspaceId)){
        pendingTaskId.value=null;
        if(reload)void refresh();else{schedulePoll();if(selectedTaskId.value)void loadHistory(selectedTaskId.value);}
      }
    }
  }
  function toggle(id:string,enabled:boolean){return mutate(id,{enabled});}
  function interval(id:string,minutes:number){const periodMs=Math.round(minutes*60000);if(!Number.isFinite(minutes)||!Number.isSafeInteger(periodMs)||periodMs<MIN_SYNC_PERIOD_MS||periodMs>MAX_SYNC_PERIOD_MS){error.value='同步周期须为1分钟至30天。';return Promise.resolve();}return mutate(id,{periodMs});}
  watch(()=>[props.workspace.id,props.workspace.role,props.connectionId],()=>{
    generation++;controller.abort();controller=new AbortController();stopPoll();resetHistory();tasks.value=[];pendingTaskId.value=null;error.value='';notice.value='';loadState.value=canManage.value?'loading':'denied';if(canManage.value)void refresh();
  },{immediate:true});
  onUnmounted(()=>{generation++;controller.abort();historyController.abort();stopPoll();emit('busyChanged',false);});
  return {canManage,taskRows,historyRows,loadState,error,notice,pendingTaskId,selectedTaskId,historyLoading,historyError,nextCursor,refresh,loadHistory,toggle,interval,sync:(id:string)=>mutate(id)};
}
