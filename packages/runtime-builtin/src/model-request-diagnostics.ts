import type {ModelProtocol} from '@dentity/contracts';
import type {ModelRequestDiagnostic} from '@dentity/application';

/** Inspect only our serialized wire structure; never retain any content or URLs. */
export function modelRequestDiagnostic(input:{id:string;protocol:ModelProtocol;imageInputEnabled:boolean;referencedImages:number;readImages:number;imageBytes:number;requestBytes:number},wire:Record<string,unknown>):ModelRequestDiagnostic {
 const messages=input.protocol==='openai_responses'?wire['input']:wire['messages'];
 const imageType=input.protocol==='openai_responses'?'input_image':input.protocol==='anthropic_messages'?'image':'image_url';
 let imageBlocks=0;
 if(Array.isArray(messages))for(const message of messages){
  if(!message||typeof message!=='object'||!Array.isArray(message.content))continue;
  for(const part of message.content)if(part&&typeof part==='object'&&part.type===imageType)imageBlocks++;
 }
 return{id:input.id,protocol:input.protocol,imageInputEnabled:input.imageInputEnabled,referencedImages:input.referencedImages,readImages:input.readImages,imageBlocks,imageBytes:input.imageBytes,requestBytes:input.requestBytes};
}
