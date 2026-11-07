import {nullDiagnostics,type DiagnosticPort} from '@dentity/application';
import type {Store} from '../store.js';
import {SqliteMessageLoopRepository} from './repository.js';
/** Legacy constructor name only. Queue facts and payloads now live exclusively in SQLite. */
export class MemoryMessageLoopRepository extends SqliteMessageLoopRepository {
 constructor(store:Store,now:()=>number=Date.now,_legacyTtlMs=300000,diagnostics:DiagnosticPort=nullDiagnostics){super(store,now,diagnostics);}
}
