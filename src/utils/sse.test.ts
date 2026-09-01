import { describe, expect, it, vi } from 'vitest';
import { writeSseEvent } from './sse.js';

describe('writeSseEvent', () => {
  it('writes normalized delta as SSE data line', () => {
    const chunks: string[] = [];
    const res = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as import('express').Response;

    writeSseEvent(res, { type: 'delta', text: 'hi' });

    expect(chunks.join('')).toContain('data: {"type":"delta","text":"hi"}');
    expect(chunks.join('')).toContain('\n\n');
  });
});
