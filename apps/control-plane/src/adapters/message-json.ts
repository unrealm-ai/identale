const sensitiveKeys=new Set(['token','accesstoken','refreshtoken','tenantaccesstoken','appaccesstoken','verificationtoken','secret','appsecret','clientsecret','encryptkey','privatekey','apikey','password','authorization','cookie','setcookie','signature']);
const sensitive=(key:string)=>{
  const name=key.replace(/[^a-z0-9]/gi,'').toLowerCase();
  return sensitiveKeys.has(name)||/(?:token|secret|password|signature|apikey)$/.test(name)||name.includes('authorization');
};
/** Snapshot message JSON, keep its fields, and redact credential fields and reflected known credentials. */
export function redactMessageJson(value:unknown,knownSecrets:readonly string[]=[]):unknown {
  const snapshot:unknown=JSON.parse(JSON.stringify(value));
  const secrets=new Set(knownSecrets.filter(v=>v&&v!=='***'));
  const collect=(node:unknown)=>{
    if(!node||typeof node!=='object')return;
    for(const [key,item] of Object.entries(node)){
      if(sensitive(key)&&typeof item==='string'&&item&&item!=='***')secrets.add(item);
      collect(item);
    }
  };
  collect(snapshot);
  const strings=[...secrets].sort((a,b)=>b.length-a.length);
  const redact=(node:unknown):unknown=>{
    if(typeof node==='string'){for(const secret of strings)node=(node as string).replaceAll(secret,'***');return node;}
    if(Array.isArray(node))return node.map(redact);
    if(node&&typeof node==='object'){
      const result:Record<string,unknown>=Object.create(null);
      for(const [key,item]of Object.entries(node))result[key]=sensitive(key)?'***':redact(item);
      return result;
    }
    return node;
  };
  return redact(snapshot);
}
