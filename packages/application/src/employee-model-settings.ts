import {isThinkingLevel,type ThinkingLevel} from '@dentity/contracts';
import {TaskError,taskBody} from './tasks/service.js';
export interface EmployeeModelSettings {selectedProfileId:string|null;executionThinkingLevel:ThinkingLevel;revision:string}
export interface EmployeeModelSettingsPort {
 read(workspaceId:string,entityId:string):EmployeeModelSettings;
 transaction<T>(fn:()=>T):T;
 select(workspaceId:string,entityId:string,profileId:string|null):void;
 thinking(workspaceId:string,entityId:string,thinking:ThinkingLevel):void;
}
export class EmployeeModelSettingsService {
 constructor(private readonly port:EmployeeModelSettingsPort,private readonly authorize:(u:string,w:string,e:string)=>void){}
 read(u:string,w:string,e:string){this.authorize(u,w,e);return this.port.read(w,e);}
 save(u:string,w:string,e:string,value:unknown){this.authorize(u,w,e);const b=taskBody(value,['profileId','executionThinkingLevel','expectedRevision']);if((b['profileId']!==null&&(typeof b['profileId']!=='string'||!b['profileId']))||!isThinkingLevel(b['executionThinkingLevel'])||typeof b['expectedRevision']!=='string')throw new TaskError(400,'invalid_model_settings');const thinking=b['executionThinkingLevel'],profile=b['profileId'] as string|null;return this.port.transaction(()=>{if(this.port.read(w,e).revision!==b['expectedRevision'])throw new TaskError(409,'model_settings_conflict');this.port.select(w,e,profile);this.port.thinking(w,e,thinking);return this.port.read(w,e);});}
}
