import { DirectoryError } from '@dentity/application';
import { DirectoryHttp,DirectoryRequestError, feishuEnvelope,fieldFailure,isScopeName } from '../adapters/directory/http.js';
import { failedCheck, type ChannelCheck } from './validation.js';

const directoryScopes = ['tenant:tenant:readonly', 'contact:contact.base:readonly', 'contact:contact:access_as_app', 'contact:contact:readonly', 'contact:contact:readonly_as_app', 'contact:user.base:readonly', 'contact:user.department:readonly', 'contact:department.base:readonly', 'contact:department.organize:readonly'];
const optionalScopes = { group_history: ['im:message.group_msg'], meeting_materials: ['minutes:minutes.transcript:export', 'minutes:minutes.artifacts:read'] } as const;
const relevant = new Set([...directoryScopes, ...optionalScopes.group_history, ...optionalScopes.meeting_materials]);

/** Official application/v6/scope/list: 1=granted, 2=undelegated. Unknown enums/identity types stay unknown.
 * Inventory is evidence, not an AND-list of every historical/granular permission alternative.
 */
export async function inspectFeishuScopes(http: DirectoryHttp, token: string, checks: ChannelCheck[]): Promise<void> {
  const index = checks.findIndex(check => check.id === 'scope_inventory');
  try {
    const data = feishuEnvelope(await http.request('https://open.feishu.cn', '/open-apis/application/v6/scopes', 'GET', undefined, { authorization: `Bearer ${token}` }));
    if (data.has_more === true) throw new DirectoryError('limit_exceeded');
    if(!Array.isArray(data.scopes))throw fieldFailure(data,'data.scopes',data.scopes,'array');
    const scopes = data.scopes;
    if (scopes.length > 10000) throw new DirectoryError('limit_exceeded');
    const states = new Map<string, 'granted' | 'denied' | 'unverified'>();
    const inventory: NonNullable<ChannelCheck['scopeInventory']> = [];
    const seen=new Map<string,NonNullable<ChannelCheck['scopeInventory']>[number]>();
    const uncertain=new Set<string>();
    let firstIssue:DirectoryRequestError|undefined,issueCount=0;
    for (const [index,value] of scopes.entries()) {
      try{
        if(!value||typeof value!=='object'||Array.isArray(value))throw fieldFailure(data,`data.scopes[${index}]`,value,'object');
        const row=value as Record<string,unknown>,name=row.scope_name;
        if(!isScopeName(name))throw fieldFailure(data,`data.scopes[${index}].scope_name`,name,'valid scope name');
        const identity=row.scope_type==='tenant'?'tenant':row.scope_type==='user'?'user':'unknown';
        const key=JSON.stringify([identity,name]),previous=seen.get(key);
        const invalidate=()=>{uncertain.add(key);if(previous)previous.status='unverified';if(identity==='tenant'&&relevant.has(name))states.set(name,'unverified');};
        if(!Number.isSafeInteger(row.grant_status)){invalidate();throw fieldFailure(data,`data.scopes[${index}].grant_status`,row.grant_status,'integer');}
        const state = uncertain.has(key)?'unverified':row.grant_status === 1 ? 'granted' : row.grant_status === 2 ? 'denied' : 'unverified';
        if(previous&&previous.status!==state){invalidate();throw fieldFailure(data,`data.scopes[${index}].grant_status`,row.grant_status,'consistent duplicate status');}
        if(previous)continue;
        const item:NonNullable<ChannelCheck['scopeInventory']>[number]={scope:name,identity,status:state};inventory.push(item);seen.set(key,item);
        // A granted user scope is never evidence for the tenant token used by this integration.
        if(identity==='tenant'&&relevant.has(name))states.set(name,state);
      }catch(error){if(!(error instanceof DirectoryRequestError))throw error;firstIssue??=error;issueCount++;}
    }
    checks[index] = { ...(firstIssue?failedCheck('scope_inventory',firstIssue,false):{id:'scope_inventory' as const,required:false,supported:true,status:'pass' as const}),supported:true,scopeInventory:inventory,scopeEvidence:[...relevant].map(scope=>({scope,status:states.get(scope)??'unverified'})),...(issueCount?{inventoryDiagnostics:{totalRows:scopes.length,issueCount}}:{}) };
    for (const id of ['group_history', 'meeting_materials'] as const) {
      const item = checks.find(check => check.id === id)!;
      item.scopeEvidence = optionalScopes[id].map(scope => ({ scope, status: states.get(scope) ?? 'unverified' }));
      const denied = item.scopeEvidence.filter(value => value.status === 'denied').map(value => value.scope);
      if (denied.length) { item.status = 'missing'; item.reason = 'scope_denied'; item.missingScopes = denied; }
    }
  } catch (error) {
    // Inventory failure cannot replace direct contact/name proof with a guessed permission verdict.
    checks[index] = { ...failedCheck('scope_inventory', error, false), supported: true };
  }
}
