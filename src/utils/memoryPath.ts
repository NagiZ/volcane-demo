export const DEFAULT_USER_PROFILE_PATH = '/user_profile.json';

/** 空 → 默认画像路径；无前导 / 则补上 */
export function normalizeMemoryPath(input?: string | null): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return DEFAULT_USER_PROFILE_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}
