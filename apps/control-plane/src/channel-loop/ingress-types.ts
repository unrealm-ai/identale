import type {ChannelIngressPort, ChannelIngressSession} from '@dentity/application';
/** Infrastructure only. Secret is delivered via IPC, never argv or user DTO. */
export type ChannelIngressCredentials = {appSecret: string; botSecret?: never} | {botSecret: string; appSecret?: never};
export type ChannelIngressFactory = (session: ChannelIngressSession, credentials: ChannelIngressCredentials) => ChannelIngressPort;
