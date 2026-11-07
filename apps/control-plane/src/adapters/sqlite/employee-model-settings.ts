import {createHash} from 'node:crypto';
import type {ThinkingLevel} from '@dentity/contracts';
import type {EmployeeModelSettingsPort} from '@dentity/application';
import type {Store} from '../../store.js';
import type {ModelProfileService} from '../../model-profiles.js';
export class SqliteEmployeeModelSettings implements EmployeeModelSettingsPort {
 constructor(private readonly store:Store,private readonly profiles:ModelProfileService){}
 transaction<T>(fn:()=>T){return this.store.transaction(fn);}
 read(w:string,e:string){const r=this.store.one<{executionThinkingLevel:ThinkingLevel;modelRevision:number}>('SELECT execution_thinking_level AS executionThinkingLevel,model_settings_revision AS modelRevision FROM entities WHERE workspace_id=? AND id=?',w,e)!;const selectedProfileId=this.profiles.selectedProfileId(w,e),revision=createHash('sha256').update(JSON.stringify([selectedProfileId,r.executionThinkingLevel,r.modelRevision,this.profiles.selectionRevision(w,e),this.profiles.revisionKey(w,e)])).digest('hex');return {selectedProfileId,executionThinkingLevel:r.executionThinkingLevel,revision};}
 select(w:string,e:string,p:string|null){this.profiles.select(w,e,p);}
 thinking(w:string,e:string,t:ThinkingLevel){this.store.run('UPDATE entities SET execution_thinking_level=?,model_settings_revision=model_settings_revision+1 WHERE workspace_id=? AND id=?',t,w,e);}
}
