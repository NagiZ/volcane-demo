import { describe, expect, it } from 'vitest';
import { extractTextDeltaFromArkEvent } from './arkEventParser.js';

describe('extractTextDeltaFromArkEvent', () => {
  it('extracts delta text from assistant message chunk', () => {
    const raw = {
      type: 'response.output_text.delta',
      delta: '你好',
    };
    expect(extractTextDeltaFromArkEvent(raw)).toBe('你好');
  });

  it('returns null for non-text events', () => {
    expect(extractTextDeltaFromArkEvent({ type: 'tool.start' })).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(extractTextDeltaFromArkEvent(null)).toBeNull();
  });
});
