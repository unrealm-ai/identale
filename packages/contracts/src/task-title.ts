/** Display metadata only. Never use a title as execution input or an identity key. */
export const TASK_TITLE_LIMIT = 60;
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export const normalizeTaskTitle = (value: string) => value.replace(/\s+/gu, ' ').trim();
export const taskTitleLength = (value: string) => [...graphemes.segment(value)].length;
export function shortenTaskTitle(value: string, limit = TASK_TITLE_LIMIT): string {
  const parts = [...graphemes.segment(normalizeTaskTitle(value))].map(part => part.segment);
  return parts.length <= limit ? parts.join('') : parts.slice(0, limit - 1).join('') + '…';
}
export function taskDisplayTitle(task: { title?: string | null | undefined; input: string }): string {
  return shortenTaskTitle(task.title?.trim() || task.input) || '未命名任务';
}
/** First Task/Run creation time, not dispatch/notification retry time. */
export function timedTaskTitle(prefix: string, at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  const stamp = ['year', 'month', 'day', 'hour', 'minute'].map(part).join('');
  return shortenTaskTitle(prefix, TASK_TITLE_LIMIT - stamp.length - 1) + ' ' + stamp;
}
