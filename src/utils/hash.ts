import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** MVP：webUserToken → tokenHash。后续可替换为 auth-service → userId。 */
export function resolveUserKey(webUserToken: string): { tokenHash: string } {
  return { tokenHash: sha256Hex(webUserToken) };
}
