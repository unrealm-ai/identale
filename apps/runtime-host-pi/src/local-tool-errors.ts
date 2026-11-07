/** Only fixed, bounded diagnostics cross the native worker boundary. Never serialize an Error. */
const failures = {
  FILE_NOT_FOUND: ['tool_failure', 'File not found'],
  ACCESS_DENIED: ['tool_failure', 'Permission denied for the requested file operation'],
  INVALID_FILE_PATH: ['tool_failure', 'The requested file path cannot be used'],
  READ_ONLY_FILESYSTEM: ['tool_failure', 'The requested filesystem is read-only'],
  TOOL_FAILED: ['tool_failure', 'Local native tool failed; check the tool arguments'],
  TOOL_NOT_ACTIVE: ['tool_failure', 'Local tool not active or approved'],
  TOOL_INPUT_TOO_LARGE: ['tool_failure', 'Local tool input too large'],
  TOOL_START_FAILED: ['tool_failure', 'Local native tool could not start'],
  TOOL_RESPONSE_INVALID: ['protocol_error', 'Local tool response invalid; execution outcome unknown; do not automatically retry'],
  TOOL_TIMEOUT: ['outcome_unknown', 'Local tool timed out; execution outcome unknown; do not automatically retry'],
  TOOL_INTERRUPTED: ['outcome_unknown', 'Local tool interrupted; execution outcome unknown; do not automatically retry'],
  TOOL_OUTPUT_LIMIT: ['outcome_unknown', 'Local tool output limit exceeded; execution outcome unknown; do not automatically retry'],
  TOOL_OUTCOME_UNKNOWN: ['outcome_unknown', 'Local tool execution outcome unknown; do not automatically retry'],
} as const;
export type LocalToolErrorCode = keyof typeof failures;
type ErrorType = 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'AbortError';
const errorTypes = new Set<ErrorType>(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError']);
export interface LocalToolFailure {
  kind: 'tool_failure' | 'protocol_error' | 'outcome_unknown';
  code: LocalToolErrorCode;
  errorType: ErrorType;
}
export class LocalToolError extends Error {
  readonly kind: LocalToolFailure['kind'];
  readonly outcome: 'failed' | 'unknown';
  constructor(readonly code: LocalToolErrorCode, readonly errorType: ErrorType = 'Error') {
    super(`${code}: ${failures[code][1]}`);
    this.name = 'LocalToolError';
    this.kind = failures[code][0];
    this.outcome = this.kind === 'tool_failure' ? 'failed' : 'unknown';
  }
  toFailure(): LocalToolFailure { return { kind: this.kind, code: this.code, errorType: this.errorType }; }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** File-open/access errors are definite failures; unclassified in-flight mutations stay unknown. */
export function nativeToolFailure(error: unknown, mayHaveMutated: boolean, fileOpenFailed = false): LocalToolFailure {
  if (error instanceof LocalToolError) return error.toFailure();
  const errorType = error instanceof Error && errorTypes.has(error.name as ErrorType) ? error.name as ErrorType : 'Error';
  const code = record(error) ? error['code'] : undefined;
  // An errno from Bash output collection is not evidence that the command failed.
  // Only read-only work or an observed file-tool open/access failure can be definite.
  if (mayHaveMutated && !fileOpenFailed) return new LocalToolError('TOOL_OUTCOME_UNKNOWN', errorType).toFailure();
  const fileCode = code === 'ENOENT' ? 'FILE_NOT_FOUND'
    : code === 'EACCES' || code === 'EPERM' ? 'ACCESS_DENIED'
    : code === 'ENOTDIR' || code === 'EISDIR' || code === 'ENAMETOOLONG' || code === 'ELOOP' || code === 'EEXIST' ? 'INVALID_FILE_PATH'
    : code === 'EROFS' ? 'READ_ONLY_FILESYSTEM' : undefined;
  return new LocalToolError(fileCode ?? (mayHaveMutated ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_FAILED'), errorType).toFailure();
}

/** Strictly distinguish the native failure envelope from corrupt/incomplete protocol data. */
export function parseLocalToolResponse(raw: string): unknown {
  const invalid = () => new LocalToolError('TOOL_RESPONSE_INVALID');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!record(value)) throw invalid();
  if (value['ok'] === false) {
    const error = value['error'];
    if (!record(error) || Object.keys(error).some(key => !['kind', 'code', 'errorType'].includes(key))
      || typeof error['code'] !== 'string' || !Object.hasOwn(failures, error['code'])
      || !errorTypes.has(error['errorType'] as ErrorType)) throw invalid();
    const failure = new LocalToolError(error['code'] as LocalToolErrorCode, error['errorType'] as ErrorType);
    if (error['kind'] !== failure.kind) throw invalid();
    throw failure;
  }
  const result = value['result'];
  if (value['ok'] !== true || !record(result) || !Array.isArray(result['content'])
    || result['content'].some(part => !record(part) || !(part['type'] === 'text' && typeof part['text'] === 'string'
      || part['type'] === 'image' && typeof part['data'] === 'string' && typeof part['mimeType'] === 'string'))
    || result['isError'] !== undefined && typeof result['isError'] !== 'boolean') throw invalid();
  return result;
}
