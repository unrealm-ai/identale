/** A lossy, text-only label for the bounded list excerpt; never modifies the message. */
export function conversationPreview(value:string|null|undefined):string {
 if(!value)return '';
 return value.replace(/\r\n?/g,'\n')
  .replace(/^\s{0,3}(?:`{3,}|~{3,})[^\n]*$/gm,'')
  .replace(/^\s*\[[^\]\n]+\]:[^\n]*$/gm,'')
  .replace(/^\s*(?:[-*_]\s*){3,}$/gm,'')
  .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm,'')
  .replace(/^[ \t]*\|[^\n]*\|[ \t]*$/gm,line=>line.replace(/\|/g,' '))
  .replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm,'')
  .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm,'').replace(/[ \t]+#{1,6}[ \t]*$/gm,'')
  .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm,'')
  .replace(/!?\[([^\]\n]*)\]\((?:\\.|[^)])*(?:\)|$)/g,'$1')
  .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g,'$1')
  .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g,'$1')
  .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g,'')
  .replace(/(?<!\\)(`+)([\s\S]*?)\1/g,'$2')
  .replace(/(?<!\\)(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,'$2')
  .replace(/(?<![\\*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g,'$1')
  .replace(/(?<![\\\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu,'$1')
  .replace(/(?<!\\)~~([^~\n]+)~~/g,'$1')
  .replace(/\\([\\`*{}\[\]()#+.!_>~-])/g,'$1')
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[entity.toLowerCase()]!))
  .replace(/\s+/g,' ').trim();
}
