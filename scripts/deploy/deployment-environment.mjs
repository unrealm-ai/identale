import * as fs from 'node:fs/promises';

export function environmentFile(text) {
  const result = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) throw new Error('Invalid or duplicate environment configuration; no shell content was executed.');
    let value = match[2].trim();
    if (value.startsWith('"')) { try {value = JSON.parse(value);} catch {throw new Error(`Invalid quoted environment value: ${match[1]}`);} }
    else if (value.startsWith("'")) {if (!value.endsWith("'")) throw new Error('Invalid quoted environment value.'); value = value.slice(1, -1);}
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Environment values must be single-line strings.');
    result[match[1]] = value;
  }
  return result;
}
export function environmentText(values) {
  for (const [key, value] of Object.entries(values)) if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid environment configuration.');
  return Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}
export function environmentPaths(text) {
  if (!text.trim()) return [];
  const paths = []; let consumed = 0;
  const pattern = /(.+?) \(ignore_errors=(yes|no)\)(?: |$)/g;
  for (const match of text.trim().matchAll(pattern)) {
    if (match.index !== consumed || !match[1].startsWith('/')) throw new Error('Unsupported systemd EnvironmentFile metadata.');
    paths.push({file: match[1], optional: match[2] === 'yes'}); consumed += match[0].length;
  }
  if (consumed !== text.trim().length) throw new Error('Unsupported systemd EnvironmentFile metadata.');
  return paths;
}
/** systemctl escapes each Environment= word; parse quoting, never execute it. */
export function environmentWords(text) {
  const words = []; let word = '', quote = '', escaped = false, present = false;
  for (const char of text.trim()) {
    if (escaped) {word += char; escaped = false; present = true;}
    else if (char === '\\' && quote !== "'") escaped = true;
    else if (quote) {if (char === quote) quote = ''; else word += char;}
    else if (char === '"' || char === "'") {quote = char; present = true;}
    else if (/\s/.test(char)) {if (present) {words.push(word); word = ''; present = false;}}
    else {word += char; present = true;}
  }
  if (quote || escaped) throw new Error('Unsupported systemd Environment metadata.');
  if (present) words.push(word);
  const result = {};
  for (const value of words) {const equal = value.indexOf('='); if (equal < 1) throw new Error('Invalid systemd environment entry.'); result[value.slice(0, equal)] = value.slice(equal + 1);}
  return result;
}
export async function protectedEnvironment(file, optional = false) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o022 || stat.size > 1024 * 1024) throw new Error('Unsafe deployment environment file; no configuration was replaced.');
    handle = await fs.open(file, 'r');
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Deployment environment file changed while opening.');
    return environmentFile(await handle.readFile('utf8'));
  } catch (error) {if (optional && error.code === 'ENOENT') return {}; throw error;}
  finally {await handle?.close();}
}
