import { describe, expect, it, vi } from 'vitest';
import { pollSessionEventsForAgentReply } from './pollSessionEvents.js';

describe('pollSessionEventsForAgentReply', () => {
  it('emits agent.message and stops on session.status_idle', async () => {
    const deltas: string[] = [];
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'e1', type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
        { id: 'e2', type: 'session.status_running' },
      ])
      .mockResolvedValueOnce([
        { id: 'e1', type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
        { id: 'e2', type: 'session.status_running' },
        { id: 'e3', type: 'agent.message', content: [{ type: 'text', text: '你好' }] },
        { id: 'e4', type: 'session.status_idle' },
      ]);

    await pollSessionEventsForAgentReply({
      listEvents,
      onDelta: (text) => deltas.push(text),
      baselineEventIds: new Set(['old-event']),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(deltas).toEqual(['你好']);
    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  it('skips events already in baseline', async () => {
    const deltas: string[] = [];
    await pollSessionEventsForAgentReply({
      listEvents: async () => [
        { id: 'e1', type: 'agent.message', content: [{ type: 'text', text: '旧回复' }] },
        { id: 'e2', type: 'user.message', content: [{ type: 'text', text: 'new' }] },
        { id: 'e3', type: 'session.status_idle' },
      ],
      baselineEventIds: new Set(['e1']),
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(deltas).toEqual([]);
  });
});
