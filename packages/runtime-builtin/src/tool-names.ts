import type {ModelMessage, ModelTool} from './types.js';
/** Validate only. No aliases, dotted names or tool_N positional compatibility. */
export function validateModelToolNames(declarations:readonly ModelTool[],messages:readonly ModelMessage[]):void {
 const valid=(name:string)=>/^[A-Za-z0-9_-]{1,64}$/.test(name)&&!/^tool_\d+$/.test(name);
 if(new Set(declarations.map(t=>t.name)).size!==declarations.length)throw Error('Duplicate model tool declaration');
 for(const tool of declarations)if(!valid(tool.name))throw Error('Invalid model tool name');
 for(const message of messages)if(message.role==='assistant')for(const call of message.toolCalls??[])if(!valid(call.name))throw Error('Invalid model tool history name');
}
