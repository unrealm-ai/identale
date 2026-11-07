import {randomInt} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import{modelProtocolEndpoint,modelProtocolHeaders,modelProtocolRequest,modelProtocolResponse}from'@dentity/runtime-builtin';
import type {ModelProtocol,ImageInputSupport} from '@dentity/contracts';
import {nullDiagnostics,type DiagnosticPort} from '@dentity/application';
import {ModelProbeDiagnostics,responseShapeIssue} from './model-probe-diagnostics.js';

function crc(bytes:Buffer){let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(name:string,data:Buffer){const type=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([length,type,data,sum]);}
/** Synthetic bytes only; no user asset or conversation participates in a probe. */
export function imageProbeFixture(){
  const colors=[{name:'red',rgb:[230,20,30]},{name:'blue',rgb:[20,50,230]},{name:'green',rgb:[20,170,40]},{name:'yellow',rgb:[245,220,10]}];
  const selected=colors[randomInt(colors.length)]!,width=96,height=88,rows=Buffer.alloc(height*(width*3+1),255),code=String(randomInt(10000)).padStart(4,'0');
  const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
  const pixel=(x:number,y:number,rgb:readonly number[])=>{for(let k=0;k<3;k++)rows[y*(width*3+1)+1+x*3+k]=rgb[k]!;};
  for(let y=0;y<height;y++){rows[y*(width*3+1)]=0;for(let x=32;x<64;x++)if(y>=16&&y<48)pixel(x,y,selected.rgb);}
  for(let i=0;i<4;i++){const glyph=digits[Number(code[i])]!;for(let y=0;y<5;y++)for(let x=0;x<3;x++)if(glyph[y*3+x]==='1')for(let dy=0;dy<3;dy++)for(let dx=0;dx<3;dx++)pixel(25+i*12+x*3+dx,61+y*3+dy,[0,0,0]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
  return{dataUrl:'data:image/png;base64,'+png.toString('base64'),color:selected.name,shape:'square',code};
}
async function boundedJson(response:Response,probe:ModelProbeDiagnostics):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader){probe.mark('empty_body');throw Error('empty_probe_response');}
  let length=0;const chunks:Uint8Array[]=[];
  try{
    for(;;){
      let part:ReadableStreamReadResult<Uint8Array>;
      try{part=await reader.read();}catch(error){probe.mark('body_read');throw error;}
      if(part.done)break;length+=part.value.length;
      if(length>65536){probe.mark('body_limit');await reader.cancel();throw Error('probe_response_limit');}
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch(error){probe.mark(length===0?'empty_body':'payload_json');throw error;}
}
/** Optional modality observation cannot turn a valid text connection into a failed save. */
export async function probeImageInput(input:{protocol?:ModelProtocol;endpoint:string;modelId:string;apiKey:string;fetch?:typeof fetch;diagnostics?:DiagnosticPort;probeId?:string}):Promise<ImageInputSupport>{
  const fixture=imageProbeFixture();
  const protocol=input.protocol??'chat_completions',probe=new ModelProbeDiagnostics(input.diagnostics??nullDiagnostics,'image',protocol,modelProtocolEndpoint(input.endpoint,protocol),input.probeId);
  try{
    const response=await(input.fetch??fetch)(modelProtocolEndpoint(input.endpoint,input.protocol),{method:'POST',redirect:'error',signal:AbortSignal.timeout(40000),headers:modelProtocolHeaders(input.apiKey,input.protocol),body:JSON.stringify(modelProtocolRequest({model:input.modelId,stream:false,max_completion_tokens:128,reasoning_effort:'none',enable_thinking:false,messages:[{role:'user',content:[{type:'text',text:'Identify the central shape and its color. Respond only with JSON {"shape":"...","color":"...","code":"...."}. Use English lowercase shape/color and copy the four black digits exactly.'},{type:'image_url',image_url:{url:fixture.dataUrl}}]}]},input.protocol))});
    probe.response(response.status,response.headers.get('content-type'));
    const body=await boundedJson(response,probe) as {error?:{code?:unknown;message?:unknown};choices?:{finish_reason?:unknown;message?:{content?:unknown}}[]};
    if(!body||typeof body!=='object'||Array.isArray(body)){probe.mark('protocol_shape');return'unknown';}
    if(!response.ok){
      // Generic 400/auth/timeout is not proof of a modality rejection.
      const error=body.error,code=typeof error?.code==='string'?error.code:'',message=typeof error?.message==='string'?error.message:'';
      const unsupported=[400,422].includes(response.status)&&(['unsupported_image_input','vision_not_supported','image_not_supported'].includes(code)||/\b(?:image|vision)\b.{0,100}\b(?:not supported|unsupported)\b|\bdoes not support\b.{0,60}\b(?:image|vision)\b/i.test(message));
      probe.mark(unsupported?'unsupported_image':'http_status');return unsupported?'unsupported':'unknown';
    }
    let normalized:typeof body;
    try{normalized=modelProtocolResponse(body,input.protocol)as typeof body;}catch{probe.mark('protocol_shape');return'unknown';}
    if(normalized.choices?.[0]?.finish_reason!=='stop'){probe.mark(responseShapeIssue(protocol,body));return'unknown';}
    const content=normalized.choices?.[0]?.message?.content;
    if(typeof content!=='string'){probe.mark('protocol_shape');return'unknown';}
    let answer:{shape?:unknown;color?:unknown;code?:unknown};
    try{answer=JSON.parse(content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{probe.mark('answer_json');return'unknown';}
    if(!answer||typeof answer!=='object'||Array.isArray(answer)){probe.mark('answer_mismatch');return'unknown';}
    const passed=answer.shape===fixture.shape&&answer.color===fixture.color&&answer.code===fixture.code;
    probe.mark(passed?'passed':'answer_mismatch');return passed?'passed':'unknown';
  }catch(error){
    if(error&&typeof error==='object'&&['TimeoutError','AbortError'].includes(String((error as {name?:unknown}).name)))probe.mark('timeout');
    return'unknown';
  }finally{probe.finish();}
}
