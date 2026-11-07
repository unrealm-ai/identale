import type{Store}from'../store.js';
/** Persisted ownership, not model intent or Task success alone, suppresses the
 * ordinary result path. Apply BEFORE candidate LIMIT, retain claim-time guards. */
export function unmanagedTaskSql(store:Store,taskId:string){
 if(!/^[a-z]+\.[a-z_]+$/.test(taskId))throw Error('invalid_managed_task_expression');
 return ['work_item_task_links','work_item_intents'].filter(table=>store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table)).map(table=>`NOT EXISTS(SELECT 1 FROM ${table} managed WHERE managed.task_id=${taskId})`).join(' AND ')||'1=1';
}
