import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_PROFILE_PATH, normalizeMemoryPath } from './memoryPath.js';

describe('normalizeMemoryPath', () => {
  it('defaults empty to user_profile.json', () => {
    expect(normalizeMemoryPath(undefined)).toBe(DEFAULT_USER_PROFILE_PATH);
    expect(normalizeMemoryPath('')).toBe(DEFAULT_USER_PROFILE_PATH);
    expect(normalizeMemoryPath('   ')).toBe(DEFAULT_USER_PROFILE_PATH);
  });

  it('adds leading slash', () => {
    expect(normalizeMemoryPath('user_profile.json')).toBe('/user_profile.json');
    expect(normalizeMemoryPath('/prefs/a.json')).toBe('/prefs/a.json');
  });
});
