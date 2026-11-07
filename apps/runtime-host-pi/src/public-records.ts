import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { ExecutionRecordContent, ExecutionRecordPage, ExecutionRecordQuery, PublicExecutionRecord } from '@dentity/contracts';
import { nativeRecordFile } from './raw-records.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('base64url');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const secretKey = (key: string) => /(?:token|secret|password|signature|apikey|authorization|cookie|privatekey)$/i.test(key.replace(/[^a-z0-9]/gi, ''));
function safeText(value: string): string {
  let text = value;
  try { const json: unknown = JSON.parse(text); if (object(json) || Array.isArray(json)) text = JSON.stringify(safeJson(json), null, 2); } catch { /* Ordinary visible text. */ }
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[redacted]')
    .replace(/(["']?(?:api[_-]?key|\w*token|\w*secret|password|authorization|cookie)["']?\s*[:=]\s*)(["']?)([^\s,"'<>}]+)\2/gi, (match, prefix:string, quote:string, value:string) => /^Bearer$/i.test(value) ? match : `${prefix}${quote}[redacted]${quote}`);
}
function safeJson(value: unknown): unknown {
  const secrets = new Set<string>();
  function collect(v: unknown) { if (v && typeof v === 'object') for (const [key, item] of Object.entries(v)) { if (secretKey(key) && typeof item === 'string' && item.length) secrets.add(item); else collect(item); } }
  collect(value);
  function visit(v: unknown): unknown {
    if (typeof v === 'string') { let text = v; for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[redacted]'); return safeText(text); }
    if (Array.isArray(v)) return v.map(visit);
    if (object(v)) return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, secretKey(key) ? '[redacted]' : visit(item)]));
    return v;
  }
  return visit(value);
}
interface Token { v: 1; kind: 'cursor' | 'entry'; scope: string; file: string; p: number; size: number; anchor: string; block: number; end?: number; hash?: string; modified?:number }
interface Item { type: PublicExecutionRecord['type']; block: number; createdAt: number; toolName?: string; toolCallId?: string; isError?: boolean; restricted?:boolean; body: () => string }
function items(entry: unknown): Item[] {
  if (!object(entry) || entry['type'] !== 'message' || !object(entry['message'])) return [];
  const m = entry['message'], createdAt = typeof m['timestamp'] === 'number' ? m['timestamp'] : typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
  if (!Number.isFinite(createdAt) || createdAt < 0) return [];
  const name = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v) ? v : '工具';
  const callId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : '';
  if (m['role'] === 'assistant' && Array.isArray(m['content'])) return m['content'].flatMap((part: unknown, block): Item[] => {
    if (!object(part)) return [];
    if (part['type'] === 'text' && typeof part['text'] === 'string') return [{ type: 'reply', block, createdAt, body: () => safeText(part['text'] as string) }];
    if (part['type'] === 'toolCall' && object(part['arguments'])) return [{ type: 'tool_call', block, createdAt, toolName: name(part['name']), toolCallId: callId(part['id']), body: () => JSON.stringify(safeJson(part['arguments']), null, 2) }];
    return []; // thinking/signatures/encrypted content are never public summaries.
  });
  if (m['role'] === 'toolResult' && Array.isArray(m['content'])) return [{ type: 'tool_result', block: -1, createdAt, toolName: name(m['toolName']), toolCallId: callId(m['toolCallId']), isError: m['isError'] === true,restricted:['context_read','context.read','asset_read','asset.read'].includes(String(m['toolName'])),
    body: () => safeText((m['content'] as unknown[]).filter((p): p is { type: string; text: string } => object(p) && p['type'] === 'text' && typeof p['text'] === 'string').map(p => safeText(p.text)).join('\n')) }];
  return []; // user/system/custom/compaction/internal details and images are excluded.
}

/** Stateless signed offsets: no second transcript, no per-request whole-file scan.
 * Cursors are source/user/Run/Session-bound; a Host restart invalidates old tokens. */
export class PublicExecutionRecordReader {
  private readonly secret = randomBytes(32);
  constructor(private readonly root: string, private readonly observeRead?: (bytes: number) => void) {}
  private contentDigest(value:Buffer){return createHmac('sha256',this.secret).update(value).digest('base64url');}
  private sign(token: Token) { const body = Buffer.from(JSON.stringify(token)).toString('base64url'); return body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url'); }
  private token(value: string, kind: Token['kind'], scope: string, file: string): Token {
    if (value.length > 6000) throw Error('cursor_invalid');
    const [body, signature, extra] = value.split('.'); if (!body || !signature || extra) throw Error('cursor_invalid');
    const expected = createHmac('sha256', this.secret).update(body).digest(), actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Error('cursor_invalid');
    const t: Token = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (t.v !== 1 || t.kind !== kind || t.scope !== scope || t.file !== file || ![t.p, t.size, t.block].every(Number.isSafeInteger) || t.p < 0 || t.size < t.p || t.block < -1) throw Error('cursor_invalid');
    return t;
  }
  read(opaque: string, scope: string, runId: string, query: ExecutionRecordQuery, start=0,frozenRequired=false): ExecutionRecordPage | ExecutionRecordContent {
    let fd: number | undefined;
    try {
      const located = nativeRecordFile(this.root, opaque,runId,frozenRequired);
      if (!located) throw Error('record_unavailable');
      fd = openSync(located.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== located.stat.ino || stat.dev !== located.stat.dev) throw Error('record_changed');
      const bytes = (position: number, length: number) => {
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, stat.size - position)));
        const n = buffer.length ? readSync(fd!, buffer, 0, buffer.length, position) : 0;
        this.observeRead?.(n); if (n !== buffer.length) throw Error('record_changed'); return buffer;
      };
      const headerBytes = bytes(0, 4096), headerEnd = headerBytes.indexOf(10);
      if (headerEnd < 0) throw Error('record_unavailable');
      const header: unknown = JSON.parse(headerBytes.subarray(0, headerEnd).toString('utf8'));
      if (!object(header) || header['type'] !== 'session' || header['version'] !== 3) throw Error('record_format_unsupported');
      const file = digest(JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, digest(headerBytes.subarray(0, headerEnd + 1))]));
      const anchor = (p: number) => this.contentDigest(bytes(Math.max(0, p - 64), Math.min(64, p)));
      const source = digest(JSON.stringify([scope, opaque, runId]));
      let token = query.entryId ? this.token(query.entryId, 'entry', source, file) : query.cursor ? this.token(query.cursor, 'cursor', source, file) : undefined;
      if (token && (stat.size < token.size || token.p > stat.size || token.anchor !== anchor(token.p) || token.kind==='cursor'&&stat.size===token.size&&token.modified!==stat.mtimeMs)) throw Error('record_changed');
      let windowStart = -1, window = Buffer.alloc(0);
      const lineAt = (position: number, end = stat.size): { bytes: Buffer; end: number } | undefined => {
        let p = position, parts: Buffer[] = [], total = 0;
        while (p < end) {
          if (p < windowStart || p >= windowStart + window.length) { windowStart = p; window = bytes(p, Math.min(65536, end - p)); }
          const rest = window.subarray(p - windowStart, Math.min(window.length, end - windowStart));
          const newline = rest.indexOf(10), part = newline < 0 ? rest : rest.subarray(0, newline + 1);
          if (!part.length) break;
          parts.push(part); total += part.length; p += part.length;
          if (total > 4 * 1024 * 1024) throw Error('record_entry_too_large');
          if (newline >= 0) return { bytes: Buffer.concat(parts), end: p };
        }
        return undefined; // A trailing incomplete line is not committed yet.
      };
      const make = (p: number, block: number, kind: Token['kind'] = 'cursor', extra: Partial<Token> = {}) => this.sign({ v: 1, kind, scope: source, file, p, block, size: stat.size, anchor: anchor(p),...(kind==='cursor'?{modified:stat.mtimeMs}:{}), ...extra });
      if (query.entryId) {
        if (!token || !Number.isSafeInteger(token.end) || token.end! <= token.p || token.end! > stat.size) throw Error('cursor_invalid');
        const line = lineAt(token.p, token.end);
        if (!line || line.end !== token.end || this.contentDigest(line.bytes) !== token.hash) throw Error('record_changed');
        const item = items(JSON.parse(line.bytes.toString('utf8'))).find(item => item.block === token!.block);
        if (!item) throw Error('record_changed');
        if(item.restricted)return {text:'',nextOffset:null,unavailableReason:'restricted_context'};
        const text = Array.from(item.body()), offset = query.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw Error('cursor_invalid');
        return { text: text.slice(offset, offset + 8000).join(''), nextOffset: text.length > offset + 8000 ? offset + 8000 : null };
      }
      let p = token?.p ?? Math.max(headerEnd+1,located.frozen?0:start), block = token?.block ?? 0, consumed = 0;
      const records: PublicExecutionRecord[] = [];
      while (p < stat.size && records.length < 40 && consumed < 512 * 1024) {
        const line = lineAt(p); if (!line) break;
        consumed += line.end - p;
        const visible = items(JSON.parse(line.bytes.toString('utf8'))).filter(item => item.block >= block || item.block === -1 && block === 0),lineHash=this.contentDigest(line.bytes);
        for (let i = 0; i < visible.length; i++) {
          const item = visible[i]!, body = item.type === 'reply' ? Array.from(item.body()) : [];
          records.push({ id: make(p, item.block, 'entry', { end: line.end, size: line.end, hash: lineHash }), runId, type: item.type, createdAt: item.createdAt, text: body.slice(0, 1200).join(''), textLength: item.type === 'reply' ? body.length : -1,
            ...(item.toolName ? { toolName: item.toolName } : {}), ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}), ...(item.isError !== undefined ? { isError: item.isError } : {}),...(item.restricted?{restricted:true}:{}) });
          if (records.length === 40 && i < visible.length - 1) { const cursor = make(p, visible[i + 1]!.block); return { status: 'available', records, nextCursor: cursor, tailCursor: cursor }; }
        }
        p = line.end; block = 0;
      }
      const cursor = make(p, block), atEnd = p >= stat.size || consumed < 512 * 1024 && records.length < 40;
      return { status: 'available', records, nextCursor: atEnd ? null : cursor, tailCursor: cursor };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '';
      return { status: /cursor|changed/.test(reason) ? 'changed' : 'unavailable', reason: ['cursor_invalid','record_changed','record_entry_too_large','record_format_unsupported'].includes(reason) ? reason : 'record_unavailable', records: [], nextCursor: null, tailCursor: null };
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}
