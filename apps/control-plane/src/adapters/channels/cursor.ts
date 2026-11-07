import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ChannelError, type ChannelConnection, type ChannelQuery, type ChannelResourceRef } from '@dentity/application';
export interface ProviderContinuation { token: string; offset?: number }
/** Ephemeral per-adapter key. Restart/adapter replacement invalidates cursors: begin a new query. */
export class ChannelCursorCodec {
  private readonly key = randomBytes(32);
  encode(scope: string, value: ProviderContinuation): string {
    this.validate(value);
    const payload = Buffer.from(JSON.stringify({version:1,scope,...value})).toString('base64url');
    return `${payload}.${this.mac(payload).toString('base64url')}`;
  }
  decode(scope: string, cursor: string): ProviderContinuation {
    try {
      if (typeof cursor !== 'string' || cursor.length > 16000) throw new Error();
      const parts = cursor.split('.');
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) throw new Error();
      const signature = Buffer.from(parts[1]!,'base64url'), expected = this.mac(parts[0]!);
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const row = value as Record<string, unknown>;
      if (row.version !== 1 || row.scope !== scope || typeof row.token !== 'string') throw new Error();
      const result: ProviderContinuation = {token:row.token, ...(row.offset === undefined ? {} : {offset:row.offset as number})};
      this.validate(result); return result;
    } catch { throw new ChannelError('invalid_request', 'invalid_or_expired_channel_cursor'); }
  }
  private mac(payload: string): Buffer { return createHmac('sha256',this.key).update(payload).digest(); }
  private validate(value: ProviderContinuation): void {
    if (!value.token || value.token.length > 8192 || /[\x00-\x1f]/.test(value.token) || value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0)) throw new ChannelError('invalid_request','invalid_provider_cursor');
  }
}
export function channelCursorScope(connection: ChannelConnection, ref: ChannelResourceRef, query: Omit<ChannelQuery,'cursor'>): string {
  return JSON.stringify([connection.workspaceId,connection.connectionId,connection.provider,connection.tenantId,connection.identity.kind,connection.identity.externalId,connection.credentialRef,ref.kind,ref.externalId,query.startAt??null,query.endAt??null,query.limit??null,query.threadId??null,query.order??'asc']);
}
