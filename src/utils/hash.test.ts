import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveUserKey, sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('returns lowercase hex digest', () => {
    expect(sha256Hex('hello')).toBe(
      createHash('sha256').update('hello').digest('hex'),
    );
  });
});

describe('resolveUserKey', () => {
  it('maps webUserToken to tokenHash', () => {
    const token = 'user-token-abc';
    expect(resolveUserKey(token)).toEqual({
      tokenHash: sha256Hex(token),
    });
  });
});
