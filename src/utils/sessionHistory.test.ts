import { describe, expect, it } from 'vitest';
import {
  SESSION_HISTORY_LIMIT,
  buildListRecentSessionEventsSearch,
  toChronologicalChatMessages,
} from './sessionHistory.js';

describe('buildListRecentSessionEventsSearch', () => {
  it('requests latest page newest-first with message types repeated', () => {
    expect(buildListRecentSessionEventsSearch()).toBe(
      'limit=50&order=desc&types=user.message&types=agent.message',
    );
    expect(SESSION_HISTORY_LIMIT).toBe(50);
  });

  it('allows a custom limit and page cursor', () => {
    expect(buildListRecentSessionEventsSearch({ limit: 20, page: 'page_2' })).toBe(
      'limit=20&order=desc&types=user.message&types=agent.message&page=page_2',
    );
  });
});

describe('toChronologicalChatMessages', () => {
  it('keeps user/agent messages and reverses desc payload for chat order', () => {
    const messages = toChronologicalChatMessages([
      { id: 'a2', type: 'agent.message', content: [{ type: 'text', text: '答复' }] },
      { id: 't1', type: 'agent.thinking', content: [{ type: 'text', text: '思考' }] },
      { id: 'u1', type: 'user.message', content: [{ type: 'text', text: '你好' }] },
    ]);

    expect(messages).toEqual([
      { id: 'u1', role: 'user', content: '你好' },
      { id: 'a2', role: 'agent', content: '答复' },
    ]);
  });

  it('drops empty agent.message placeholders', () => {
    expect(
      toChronologicalChatMessages([{ id: 'a1', type: 'agent.message', content: [] }]),
    ).toEqual([]);
  });
});
