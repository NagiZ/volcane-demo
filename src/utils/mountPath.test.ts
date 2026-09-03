import { describe, expect, it } from 'vitest';
import {
  allocateMountBasenames,
  arkMountPath,
  sandboxUploadPath,
  sanitizeBasename,
} from './mountPath.js';

describe('sanitizeBasename', () => {
  it('strips directories and rejects empty', () => {
    expect(sanitizeBasename('../../a/b/report.pdf')).toBe('report.pdf');
    expect(sanitizeBasename('')).toBe('file');
    expect(sanitizeBasename('...')).toBe('file');
  });
});

describe('allocateMountBasenames', () => {
  it('suffixes colliding names with short file id', () => {
    const map = allocateMountBasenames([
      { fileId: 'file-aaaa1111', name: 'a.pdf' },
      { fileId: 'file-bbbb2222', name: 'a.pdf' },
    ]);
    expect(map.get('file-aaaa1111')).toBe('a.pdf');
    expect(map.get('file-bbbb2222')).toBe('a-bbbb2222.pdf');
  });
});

describe('path helpers', () => {
  it('builds ark and sandbox paths', () => {
    expect(arkMountPath('a.pdf')).toBe('/a.pdf');
    expect(sandboxUploadPath('a.pdf')).toBe('/mnt/session/uploads/a.pdf');
  });
});
