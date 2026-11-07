import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { PasswordHasher } from '@dentity/application';

const derive = promisify(argon2);
const costs = { memory: 19_456, passes: 2, parallelism: 1 };
const saltLength = 16;
const tagLength = 32;

function encode(buffer: Buffer) {
  return buffer.toString('base64').replace(/=+$/, '');
}

function parseHash(hash: string) {
  if (hash.length > 128) return;
  const fields = hash.split('$');
  const [prefix, algorithm, version, parameters, encodedSalt, encodedTag] = fields;
  if (fields.length !== 6 || prefix !== '' || algorithm !== 'argon2id' || version !== 'v=19' ||
      !parameters || !encodedSalt || !encodedTag) return;

  const values = new Map<string, number>();
  for (const parameter of parameters.split(',')) {
    const [, name, value] = /^(m|t|p)=([1-9][0-9]{0,4})$/.exec(parameter) ?? [];
    if (!name || !value || values.has(name)) return;
    values.set(name, Number(value));
  }
  const memory = values.get('m'), passes = values.get('t'), parallelism = values.get('p');
  // The previous npm adapter also accepted its legacy defaults of 64 MiB, 3 passes and 4 lanes.
  if (!memory || !passes || !parallelism || memory < 8 * parallelism ||
      memory > 65_536 || passes > 3 || parallelism > 4) return;

  const salt = Buffer.from(encodedSalt, 'base64'), tag = Buffer.from(encodedTag, 'base64');
  if (salt.length !== saltLength || tag.length !== tagLength ||
      encode(salt) !== encodedSalt || encode(tag) !== encodedTag) return;
  return { salt, tag, costs: { memory, passes, parallelism } };
}

function deriveTag(value: string, salt: Buffer, parameters: typeof costs) {
  return derive('argon2id', { message: Buffer.from(value, 'utf8'), nonce: salt, tagLength, ...parameters });
}

/** Password work stays outside synchronous database transactions. */
export const passwordHasher: PasswordHasher = {
  async hash(value) {
    const salt = randomBytes(saltLength);
    const tag = await deriveTag(value, salt, costs);
    return `$argon2id$v=19$m=${costs.memory},p=${costs.parallelism},t=${costs.passes}$${encode(salt)}$${encode(tag)}`;
  },
  async verify(hash, value) {
    const parsed = parseHash(hash);
    if (!parsed) return false;
    return timingSafeEqual(await deriveTag(value, parsed.salt, parsed.costs), parsed.tag);
  },
};
