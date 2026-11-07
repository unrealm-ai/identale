/** Restricted JSON SAX reader for official {code,data:{summary|content}} responses.
 * It never accumulates target text or ignored string values. Not a public general JSON parser. */
export class AssetJsonError extends Error{
 constructor(readonly state:'failed'|'not_available'|'no_permission'|'pending',readonly reason:string){super(reason);}
}
const EMPTY:readonly string[]=[];
type Frame={kind:'object'|'array';phase:'keyOrEnd'|'key'|'colon'|'value'|'valueOrEnd'|'commaOrEnd';path:string[];key?:string};
class FieldParser{
 private stack:Frame[]=[];private rootDone=false;private stringMode=false;private keyMode=false;private selected=false;private escaped=false;private unicode:string|undefined;private high='';private keyText='';private atom='';private atomPath:string[]=[];private code:number|undefined;private found=false;private dataSeen=false;private completed=false;private hasText=false;private buffer='';private output:string[]=[];
 constructor(private readonly field:'summary'|'content'){}
 private fail():never{throw new AssetJsonError('failed','provider_json_invalid');}
 private same(path:string[],expected:readonly string[]){return path.length===expected.length&&path.every((v,i)=>v===expected[i]);}
 private path(){const f=this.stack.at(-1);if(!f){if(this.rootDone)this.fail();return[];}if(!['value','valueOrEnd'].includes(f.phase))this.fail();return f.kind==='object'?[...f.path,f.key!]:[...f.path,'[]'];}
 private consumeValue(){const f=this.stack.at(-1);if(f)f.phase='commaOrEnd';else this.rootDone=true;}
 private checkKind(path:string[],kind:'string'|'object'|'other'){if(this.same(path,['data'])){if(kind!=='object'||this.dataSeen)this.fail();this.dataSeen=true;}if(this.same(path,['data',this.field])&&kind!=='string')this.fail();}
 private decoded(char:string){
  if(this.high){const low=char.charCodeAt(0);if(char.length!==1||low<0xdc00||low>0xdfff)this.fail();char=String.fromCodePoint((this.high.charCodeAt(0)-0xd800)*1024+low-0xdc00+0x10000);this.high='';}
  else if(char.length===1){const n=char.charCodeAt(0);if(n>=0xd800&&n<=0xdbff){this.high=char;return;}if(n>=0xdc00&&n<=0xdfff)this.fail();}
  if(this.keyMode){this.keyText+=char;if(this.keyText.length>256)this.fail();}
  else if(this.selected){this.buffer+=char;if(/\S/u.test(char))this.hasText=true;if(this.buffer.length>=4096){this.output.push(this.buffer);this.buffer='';}}
 }
 private finishAtom(){let value:unknown;try{value=JSON.parse(this.atom);}catch{this.fail();}if(this.same(this.atomPath,['code'])){if(this.code!==undefined||typeof value!=='number'||!Number.isSafeInteger(value))this.fail();this.code=value;}this.atom='';this.consumeValue();}
 feed(char:string):void{
  if(this.stringMode){
   if(this.unicode!==undefined){if(!/^[a-fA-F0-9]$/.test(char))this.fail();this.unicode+=char;if(this.unicode.length===4){this.decoded(String.fromCharCode(parseInt(this.unicode,16)));this.unicode=undefined;}return;}
   if(this.escaped){this.escaped=false;if(char==='u'){this.unicode='';return;}const decoded:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!(char in decoded))this.fail();this.decoded(decoded[char]!);return;}
   if(char==='\\'){this.escaped=true;return;}if(char==='"'){if(this.high)this.fail();this.stringMode=false;if(this.keyMode){const f=this.stack.at(-1);if(f?.kind!=='object')this.fail();f.key=this.keyText;f.phase='colon';}else{this.consumeValue();if(this.selected){if(this.buffer){this.output.push(this.buffer);this.buffer='';}this.completed=true;this.selected=false;}}return;}if(char.charCodeAt(0)<32)this.fail();this.decoded(char);return;
  }
  if(this.atom){if(/[\s{}\[\],:"]/u.test(char)){this.finishAtom();this.feed(char);return;}this.atom+=char;if(this.atom.length>64)this.fail();return;}
  if(/\s/u.test(char)){if(!' \t\n\r'.includes(char))this.fail();return;}
  const f=this.stack.at(-1);
  if(char==='"'){this.stringMode=true;this.keyMode=f?.kind==='object'&&['keyOrEnd','key'].includes(f.phase);this.keyText='';this.high='';if(!this.keyMode){const path=this.path();this.checkKind(path,'string');if(this.same(path,['code']))this.fail();this.selected=this.same(path,['data',this.field]);if(this.selected){if(this.found)this.fail();this.found=true;}}return;}
  if(char===':'&&f?.kind==='object'&&f.phase==='colon'){f.phase='value';return;}
  if(char===','&&f?.phase==='commaOrEnd'){f.phase=f.kind==='object'?'key':'value';return;}
  if(char==='}'||char===']'){if(!f||f.kind!==(char==='}'?'object':'array')||!['commaOrEnd',f.kind==='object'?'keyOrEnd':'valueOrEnd'].includes(f.phase))this.fail();this.stack.pop();return;}
  if(char==='{'||char==='['){const path=this.path();this.checkKind(path,char==='{'?'object':'other');this.consumeValue();if(this.stack.length>=64)this.fail();this.stack.push({kind:char==='{'?'object':'array',phase:char==='{'?'keyOrEnd':'valueOrEnd',path});return;}
  const path=this.path();this.checkKind(path,'other');if(!/[-0-9tfn]/.test(char))this.fail();this.atomPath=path;this.atom=char;
 }
 take(){if(!this.output.length)return EMPTY;const out=this.output;this.output=[];return out;}
 finish(){if(this.atom)this.finishAtom();if(this.stringMode||this.stack.length||!this.rootDone)this.fail();if(this.code===undefined)this.fail();if(this.code!==0)throw new AssetJsonError([99991672,99991668,40004,234002,2091005].includes(this.code)?'no_permission':this.code===2091003?'pending':'failed',this.code===2091003?'provider_material_processing':'provider_business_error');if(!this.found||!this.completed||!this.hasText)throw new AssetJsonError('not_available','provider_material_empty');}
}
export function extractJsonText(response:Response,field:'summary'|'content'):Response{
 const parser=new FieldParser(field),decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
 async function* chunks(){const reader=response.body?.getReader();if(!reader)throw new AssetJsonError('failed','provider_empty_response');try{while(true){const part=await reader.read();if(part.done)break;for(const char of decoder.decode(part.value,{stream:true})){parser.feed(char);for(const text of parser.take())yield encoder.encode(text);}}for(const char of decoder.decode()){parser.feed(char);for(const text of parser.take())yield encoder.encode(text);}parser.finish();for(const text of parser.take())yield encoder.encode(text);}catch(error){if(error instanceof AssetJsonError)throw error;throw new AssetJsonError('failed','provider_json_invalid');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
 const iterator=chunks();return new Response(new ReadableStream<Uint8Array>({async pull(controller){try{const item=await iterator.next();if(item.done)controller.close();else controller.enqueue(item.value);}catch(error){controller.error(error);}},async cancel(){await iterator.return();}}),{headers:{'content-type':field==='summary'?'text/markdown; charset=utf-8':'text/plain; charset=utf-8'}});
}
