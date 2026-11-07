/** Pure key decision: composition confirmation must never become message submission. */
export function composerAction(event: Pick<KeyboardEvent,'key'|'isComposing'|'keyCode'|'repeat'|'altKey'|'ctrlKey'|'metaKey'|'shiftKey'>, composing: boolean): 'send'|'newline'|'none' {
  if(event.key!=='Enter'||composing||event.isComposing||event.keyCode===229||event.repeat)return 'none';
  if(event.ctrlKey||event.metaKey||event.shiftKey)return 'none';
  return event.altKey?'newline':'send';
}
