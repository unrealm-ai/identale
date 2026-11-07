import argon2 from 'argon2';
import type { PasswordHasher } from '@dentity/application';

/** Password work stays outside synchronous database transactions. */
export const passwordHasher: PasswordHasher = {
  hash(value) { return argon2.hash(value, {type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1}); },
  verify(hash, value) { return argon2.verify(hash, value); },
};
