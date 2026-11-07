import { DirectoryError, type DirectoryPort, type DirectoryProvider } from '@dentity/application';
import { WeComDirectoryAdapter, type WeComDirectoryOptions } from './wecom.js';
import { FeishuDirectoryAdapter } from './feishu.js';
import { DingTalkDirectoryAdapter, type DingTalkDirectoryOptions } from './dingtalk.js';
export { WeComDirectoryAdapter, type WeComDirectoryOptions } from './wecom.js';
export { FeishuDirectoryAdapter } from './feishu.js';
export { DingTalkDirectoryAdapter, type DingTalkDirectoryOptions } from './dingtalk.js';
export type { DirectoryAdapterOptions } from './http.js';
export function createDirectoryAdapter(provider:DirectoryProvider,options:DingTalkDirectoryOptions & Partial<Pick<WeComDirectoryOptions,'corpId'|'agentId'>>):DirectoryPort {
  if(provider==='feishu')return new FeishuDirectoryAdapter(options);
  if(provider==='dingtalk')return new DingTalkDirectoryAdapter(options);
  if(provider==='wecom'&&options.corpId&&options.agentId)return new WeComDirectoryAdapter({...options,corpId:options.corpId,agentId:options.agentId});
  throw new DirectoryError('unsupported');
}
