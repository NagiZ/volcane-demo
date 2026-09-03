import { describe, expect, it } from 'vitest';
import {
  extractTextDeltaFromArkEvent,
  extractTextFromEventContent,
  isAgentMessageEvent,
  isCustomToolUseEvent,
  isSessionIdleEvent,
  parseCustomToolUse,
  parseRequiresActionIdle,
  sessionEventKey,
} from './arkEventParser.js';

describe('extractTextFromEventContent', () => {
  it('extracts plain string content', () => {
    expect(extractTextFromEventContent('你好')).toBe('你好');
  });

  it('extracts text blocks', () => {
    expect(extractTextFromEventContent([{ type: 'text', text: '你好' }])).toBe('你好');
  });

  it('extracts a single content object', () => {
    expect(extractTextFromEventContent({ type: 'text', text: '单块' })).toBe('单块');
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
        type: 'agent.message',
        text: '顶层文本',
      }),
    ).toBe('顶层文本');
    expect(
      extractTextDeltaFromArkEvent({
        type: 'agent.message',
        message: { content: [{ type: 'text', text: '嵌套正文' }] },
      }),
    ).toBe('嵌套正文');
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

describe('custom tool parsers', () => {
  it('parses agent.custom_tool_use', () => {
    const raw = {
      id: 'evt-1',
      type: 'agent.custom_tool_use',
      name: 'get_user_order',
      input: { order_id: 'ORD-1' },
    };
    expect(isCustomToolUseEvent(raw)).toBe(true);
    expect(parseCustomToolUse(raw)).toEqual({
      id: 'evt-1',
      name: 'get_user_order',
      input: { order_id: 'ORD-1' },
    });
  });

  it('parses requires_action idle', () => {
    expect(
      parseRequiresActionIdle({
        type: 'session.status_idle',
        stop_reason: { type: 'requires_action', event_ids: ['evt-1', 'evt-2'] },
      }),
    ).toEqual({ eventIds: ['evt-1', 'evt-2'] });
  });

  it('returns null for normal idle', () => {
    expect(parseRequiresActionIdle({ type: 'session.status_idle' })).toBeNull();
    expect(
      parseRequiresActionIdle({
        type: 'session.status_idle',
        stop_reason: { type: 'end_turn', event_ids: [] },
      }),
    ).toBeNull();
  });
});
