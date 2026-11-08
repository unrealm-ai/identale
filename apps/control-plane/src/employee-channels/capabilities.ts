// Modified for Identale; see the root NOTICE.
import type { ChannelCapability, ConversationCapabilities, ChannelMediaCapabilities } from '@dentity/application';
import type { EmployeeChannelRecord } from './types.js';
import { feishuMediaCapabilities } from '../adapters/channels/feishu.js';
import { dingtalkMediaCapabilities } from '../adapters/channels/dingtalk.js';
import { wecomMediaCapabilities } from '../adapters/channels/wecom.js';
export interface ChannelConfigurationCapabilities {
  privateMessages:ChannelCapability; groupMentions:ChannelCapability; directedGroupMessages:ChannelCapability;
  ordinaryGroupMessages:ChannelCapability; keywordTriggers:ChannelCapability; recentGroupContext:ChannelCapability;
  media?:ChannelMediaCapabilities; directoryRead:ChannelCapability; meetingRead:ChannelCapability; documentRead:ChannelCapability;
}
const unsupported=(reason:string):ChannelCapability=>({supported:false,availability:'unsupported',reason});
const missing=(reason:string):ChannelCapability=>({supported:false,availability:'unknown',reason});
/** Presentation only. Never grants access, probes a provider, or infers permissions from transport state. */
export function resolveChannelConfigurationCapabilities(
  record:EmployeeChannelRecord,
  conversation?:ConversationCapabilities,
  business?:{meetingRead:ChannelCapability;documentRead:ChannelCapability},
):ChannelConfigurationCapabilities {
  const configured=record.enabled&&record.status==='verified';
  const gate=(capability:ChannelCapability|undefined):ChannelCapability=>{
    if(!capability)return missing('后端尚未声明此能力，请刷新或升级后核验。');
    if(!capability.supported||capability.availability!=='available')return {...capability,...(capability.reason==='dingtalk_app_bot_group_file_receive_unsupported'?{reason:'当前钉钉应用机器人接入尚不支持接收群文件；私聊文件可单独核验。'}:{})};
    return configured?{...capability}:{...capability,availability:'authorization_required',reason:record.enabled?'请先完成机器人身份与凭据验证。':'渠道已停用，请启用并重新验证。'};
  };
  // Fallback reflects the employee bot route only; never infer ordinary access from the context setting.
  const bot:ChannelCapability={supported:true,availability:'available'};
  const scopeRows=record.validation?.checks.filter(c=>c.id==='scope_inventory').flatMap(c=>c.scopeInventory??[]).filter(s=>s.scope==='im:message.group_msg'&&s.identity==='tenant')??[];
  const ordinary=conversation?.ordinaryMessageEvents??(record.provider==='feishu'?{supported:true,availability:scopeRows.length&&scopeRows.every(s=>s.status==='granted')?'available':'authorization_required',reason:scopeRows.length&&scopeRows.every(s=>s.status==='granted')?'已核验普通群消息接收权限。':'请在飞书授权普通群消息接收权限，并重新验证连接。'}:unsupported('当前机器人接入不支持普通群消息，不能配置关键词触发或近期群消息上下文。'));
  const media=conversation ? conversation.media : record.provider==='feishu' ? feishuMediaCapabilities({privateMessageEvents:true,mentionEvents:true,ordinaryMessageEvents:ordinary.availability==='available',proactiveSend:true,replyToMessage:true}) : record.provider==='dingtalk' ? dingtalkMediaCapabilities({streamIngress:true,privateMessageEventsGranted:true,mentionEventsGranted:true,proactiveSendGranted:true}) : wecomMediaCapabilities();
  const mapMedia=(direction:'inbound'|'outbound')=>({private:{image:gate(media![direction].private.image),file:gate(media![direction].private.file)},group:{image:gate(media![direction].group.image),file:gate(media![direction].group.file)}});
  const businessDefault=(kind:'meeting'|'document'):ChannelCapability=>record.provider==='wecom'
    ? {supported:false,availability:'unknown',reason:'企微应用资料读取接口契约尚未核验，当前未接通，不代表厂商全局不支持。'}
    : {supported:true,availability:'authorization_required',reason:record.provider==='feishu'
      ? kind==='document'?'已接入应用身份文档读取；须具备相应 API 权限和文档对象访问权，按具体资料读取结果核验，无需先登录个人账号。':'已接入应用身份妙记与明确会议实例读取；须分别核验 API 权限、对象访问权及资料生成状态，用户身份专用接口不在此路径开放。'
      : kind==='document'?'已接入钉钉应用身份文档读取；须核验 Storage.File.Read、可信消息发送人解析的 operator 与具体文档访问权。':'已接入钉钉应用身份云录制逐字稿；须核验 VideoConference.Conference.Read 与可信 operator，AI 听记不在当前范围。'};
  return {
    privateMessages:gate(conversation?.privateMessageEvents??bot),
    groupMentions:gate(conversation?.mentionEvents??(record.provider==='wecom'?unsupported('企微使用平台认证的定向机器人消息，不伪造 @ 身份。'):bot)),
    directedGroupMessages:gate(conversation?.directedBotMessageEvents??(record.provider==='wecom'?bot:unsupported('此渠道按真实 @ 事件处理。'))),
    ordinaryGroupMessages:gate(ordinary),keywordTriggers:gate(ordinary),recentGroupContext:gate(ordinary),
    ...(media?{media:{inbound:mapMedia('inbound'),outbound:mapMedia('outbound')}}:{}),
    directoryRead:record.provider==='wecom'?{supported:true,availability:'unknown',reason:'使用机器人凭据搜索成员；不支持部门或全量目录，搜索状态须单独核验。'}:{supported:true,availability:record.directoryStatus==='available'?'available':'authorization_required',reason:record.directoryStatus==='available'?'仅覆盖目录授权范围；不代表消息或业务资料权限。':'请验证目录权限与可见范围。'},
    meetingRead:business?.meetingRead??businessDefault('meeting'),documentRead:business?.documentRead??businessDefault('document'),
  };
}
