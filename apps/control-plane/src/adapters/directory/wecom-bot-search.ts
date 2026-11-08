import {createHash,randomBytes} from 'node:crypto';
import {DirectoryError,type DirectoryMemberSearch} from '@dentity/application';
import {DirectoryHttp,object,providerFailure,string,type DirectoryAdapterOptions} from './http.js';

const origin='https://qyapi.weixin.qq.com';
const base='/cli';

/** WeCom CLI protocol, restricted to discovery and contact.users.search. */
export class WeComBotMemberSearch implements DirectoryMemberSearch {
  private readonly http:DirectoryHttp;
  private session:Promise<{token:string;path:string}>|undefined;
  private expires=0;
  constructor(private readonly options:DirectoryAdapterOptions) {
    this.http=new DirectoryHttp({...options,timeoutMs:5000,maxResponseBytes:256*1024});
  }
  private parse(value:unknown) {
    if(typeof value!=='string'||value.length>256*1024)throw new DirectoryError('invalid_response');
    try {return object(JSON.parse(value));}catch {throw new DirectoryError('invalid_response');}
  }
  private async call(path:string,payload:object,token:string) {
    const response=await this.http.request(origin,path,'POST',{payload:JSON.stringify(payload)},{authorization:`Bearer ${token}`});
    if(response.errcode!==0){
      if(response.errcode===853004)throw new DirectoryError('authentication_failed');
      if([48002,850002,851008,853006].includes(Number(response.errcode)))throw providerFailure(response,'authorization_denied');
      throw providerFailure(response,'unavailable');
    }
    const result=this.parse(response.results_json);
    if(result.error&&object(result.error).code!==0){
      const code=Number(object(result.error).code);
      if(code===853004)throw new DirectoryError('authentication_failed');
      if([48002,850002,851008,853006].includes(code))throw new DirectoryError('authorization_denied');
      throw new DirectoryError('unavailable');
    }
    return this.parse(result.result);
  }
  private async connect(){
    const time=Math.floor(this.http.now()/1000),nonce=`cli_${this.http.now()}_${randomBytes(4).toString('hex')}`;
    const signature=createHash('sha256').update(this.options.appSecret+this.options.appId+time+nonce).digest('hex');
    const auth=await this.http.request(origin,'/cgi-bin/aibot/cli/get_cli_config','POST',
      {bot_id:this.options.appId,time,nonce,signature,bind_source:1},{},true);
    if(auth.errcode!==0)throw providerFailure(auth,[40001,40014,853004].includes(Number(auth.errcode))?'authentication_failed':'authorization_denied');
    const token=string(auth.token);
    if(/[\s\x7f]/.test(token))throw new DirectoryError('invalid_response');
    const schema=await this.call(base+'/service/discovery',{service:'contact'},token);
    const resources=object(schema.resources??{}),users=object(resources.users??{}),methods=object(users.methods??{});
    if(!methods.search)throw new DirectoryError('unsupported');
    const method=object(methods.search);
    if(method.http_method!=='POST'||typeof method.path!=='string'||!/^\/[a-z0-9_/-]+$/i.test(method.path))throw new DirectoryError('invalid_response');
    const prefix=schema.base_url===undefined?origin+base:string(schema.base_url);
    const url=URL.parse(prefix.replace(/\/$/,'')+method.path);
    if(!url||url.origin!==origin||url.username||url.password||url.search||url.hash||
       !/^\/(?:cli\/)?[a-z0-9_/-]+$/i.test(url.pathname)||
       !/(?:contact|user)/i.test(url.pathname)||!/(?:search|get_userlist)$/i.test(url.pathname))
      throw new DirectoryError('invalid_response');
    return {token,path:url.pathname};
  }
  async search(keywords:readonly string[]){
    if(!keywords.length||keywords.length>10||keywords.some(k=>!k.trim()||k.length>64||/[\x00-\x1f\x7f]/.test(k)))throw new DirectoryError('invalid_response');
    for(let attempt=0;attempt<2;attempt++){
      if(!this.session||this.expires<=this.http.now()){
        this.expires=this.http.now()+60_000;
        this.session=this.connect();
      }
      const session=this.session;
      let active;
      try{active=await session;}catch(error){if(this.session===session)this.session=undefined;throw error;}
      try{
        const result=await this.call(active.path,{keywords},active.token);
        const users=result.users??(result.users_count===0?[]:undefined);
        if(!Array.isArray(users)||users.length>100)throw new DirectoryError('invalid_response');
        const members=new Map<string,{id:string;displayName:string;departmentPaths:string[]}>();
        for(const item of users){
          const user=object(item),id=string(user.userid),displayName=string(user.name);
          const departmentPaths=user.departments??[];
          if(id.length>256||displayName.length>256||!Array.isArray(departmentPaths)||departmentPaths.length>32||
             departmentPaths.some(path=>typeof path!=='string'||path.length>512))throw new DirectoryError('invalid_response');
          if(!members.has(id))members.set(id,{id,displayName,departmentPaths});
        }
        return {members:[...members.values()],limited:typeof result.hint==='string'&&!!result.hint};
      }catch(error){
        if(!(error instanceof DirectoryError)||error.code!=='authentication_failed')throw error;
        if(this.session===session)this.session=undefined;
        if(attempt)throw error;
      }
    }
    throw new DirectoryError('authentication_failed');
  }
}
