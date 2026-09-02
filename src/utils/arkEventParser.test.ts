import { describe, expect, it } from 'vitest';
import {
  extractTextDeltaFromArkEvent,
  extractTextFromEventContent,
  isAgentMessageEvent,
  isSessionIdleEvent,
  sessionEventKey,
} from './arkEventParser.js';

describe('extractTextFromEventContent', () => {
  it('extracts plain string content', () => {
    expect(extractTextFromEventContent('你好')).toBe('你好');
  });

  it('extracts text blocks', () => {
    expect(extractTextFromEventContent([{ type: 'text', text: '你好' }])).toBe('你好');
  });
});

describe('extractTextDeltaFromArkEvent', () => {
  it('extracts agent.message text and ignores thinking', () => {
    expect(
      extractTextDeltaFromArkEvent({
        type: 'agent.message',
        content: [{ type: 'text', text: '我是 Agent' }],
      }),
    ).toBe('我是 Agent');
    expect(
      extractTextDeltaFromArkEvent({
        type: 'agent.thinking',
        content: 'internal reasoning',
      }),
    ).toBeNull();
  });

  it('extracts SSE delta field for stream chunks', () => {
    expect(
      extractTextDeltaFromArkEvent({
        type: 'response.output_text.delta',
        delta: '你好',
      }),
    ).toBe('你好');
  });

  it('returns null for tool events', () => {
    expect(extractTextDeltaFromArkEvent({ type: 'tool.start' })).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(extractTextDeltaFromArkEvent(null)).toBeNull();
  });
});

describe('session event helpers', () => {
  it('detects agent.message and session.status_idle', () => {
    expect(isAgentMessageEvent({ type: 'agent.message' })).toBe(true);
    expect(isSessionIdleEvent({ type: 'session.status_idle' })).toBe(true);
  });

  it('uses id as dedupe key when present', () => {
    expect(sessionEventKey({ id: 'sevt-1', type: 'agent.message' })).toBe('sevt-1');
  });
});
