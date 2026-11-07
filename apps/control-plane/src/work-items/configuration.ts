import{TaskError,taskBody}from'@dentity/application';
import type{Store}from'../store.js';
/** Platform-owned requested configuration. Runtime application is a separate fact. */
export class WorkItemConfiguration{
 constructor(readonly store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS workspace_work_item_settings(workspace_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)))');}
 /** Only called while creating a workspace, inside its creation transaction. */
 initializeWorkspace(workspaceId:string){this.store.run('INSERT INTO workspace_work_item_settings(workspace_id,revision,enabled) VALUES(?,1,1)',workspaceId);}
 get(workspaceId:string){const row=this.store.one<{revision:number;enabled:number}>('SELECT revision,enabled FROM workspace_work_item_settings WHERE workspace_id=?',workspaceId);return{revision:row?.revision??0,enabled:row?.enabled===1};}
 save(workspaceId:string,actor:string,value:unknown){const b=taskBody(value,['expectedRevision','enabled']);if(!Number.isSafeInteger(b.expectedRevision)||typeof b.enabled!=='boolean')throw new TaskError(400,'invalid_work_item_settings');return this.store.transaction(()=>{const old=this.get(workspaceId);if(old.revision!==b.expectedRevision)throw new TaskError(409,'work_item_settings_changed');const revision=old.revision+1;this.store.run('INSERT INTO workspace_work_item_settings VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled',workspaceId,revision,Number(b.enabled));this.store.run('INSERT INTO audit(at,action,user_id,workspace_id) VALUES(?,?,?,?)',Date.now(),'work-items.beta_requested',actor,workspaceId);return{revision,enabled:b.enabled};});}
}
