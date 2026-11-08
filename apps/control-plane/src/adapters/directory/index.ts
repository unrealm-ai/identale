import { DirectoryError, type DirectoryPort, type DirectoryProvider } from '@dentity/application';
import { FeishuDirectoryAdapter } from './feishu.js';
import { DingTalkDirectoryAdapter, type DingTalkDirectoryOptions } from './dingtalk.js';
export { FeishuDirectoryAdapter } from './feishu.js';
export { DingTalkDirectoryAdapter, type DingTalkDirectoryOptions } from './dingtalk.js';
export type { DirectoryAdapterOptions } from './http.js';
export function createDirectoryAdapter(provider:DirectoryProvider,options:DingTalkDirectoryOptions):DirectoryPort {
  if(provider==='feishu')return new FeishuDirectoryAdapter(options);
  if(provider==='dingtalk')return new DingTalkDirectoryAdapter(options);
  throw new DirectoryError('unsupported');
}
