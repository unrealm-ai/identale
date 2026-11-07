import {SqliteEmployeeModelSettings} from './adapters/sqlite/employee-model-settings.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {WorkbenchReadService,EmployeeModelSettingsService,type EntityService,type WorkspaceService} from '@dentity/application';
import {SqliteWorkbenchRead} from './adapters/sqlite/workbench-read.js';
import type {Store} from './store.js';
import type {ModelProfileService} from './model-profiles.js';
export function registerWorkbench(app:FastifyInstance,o:{store:Store;entities:EntityService;workspaces:WorkspaceService;profiles:ModelProfileService;auth:(r:FastifyRequest)=>{id:string};now:()=>number}){
 const read=new WorkbenchReadService(new SqliteWorkbenchRead(o.store),(u,w)=>o.workspaces.get(u,w),o.now);
 const model=new EmployeeModelSettingsService(new SqliteEmployeeModelSettings(o.store,o.profiles),(u,w,e)=>o.entities.requireManager(u,w,e));
 const base='/api/workspaces/:workspaceId',p=(r:FastifyRequest)=>r.params as {workspaceId:string;entityId:string};
 app.get(base+'/employee-summaries',r=>read.summaries(o.auth(r).id,p(r).workspaceId,r.query));
 app.get(base+'/entities/:entityId/overview',r=>read.overview(o.auth(r).id,p(r).workspaceId,p(r).entityId));
 app.get(base+'/connections',r=>read.connections(o.auth(r).id,p(r).workspaceId,r.query));
 app.get(base+'/entities/:entityId/model-settings',r=>model.read(o.auth(r).id,p(r).workspaceId,p(r).entityId));
 app.put(base+'/entities/:entityId/model-settings',r=>model.save(o.auth(r).id,p(r).workspaceId,p(r).entityId,r.body));
}
