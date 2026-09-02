import { describe, expect, it, vi } from 'vitest';
import type { ArkSessionEvent } from '../types/ark.js';
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

  it('不因长时间 tool_use 而误超时：新事件重置无进展计时', async () => {
    // 复现线上问题：Agent 连续多轮 tool_use，总耗时超过 idleTimeout，
    // 但每轮都有新事件 → 不应超时。
    const base: ArkSessionEvent[] = [
      { id: 'u1', type: 'user.message', content: [{ type: 'text', text: '查一下' }] },
    ];
    const rounds: ArkSessionEvent[][] = [
      [...base, { id: 't1', type: 'agent.thinking' }],
      [...base, { id: 't1', type: 'agent.thinking' }, { id: 't2', type: 'agent.tool_use' }],
      [
        ...base,
        { id: 't1', type: 'agent.thinking' },
        { id: 't2', type: 'agent.tool_use' },
        { id: 't3', type: 'agent.tool_result' },
      ],
      [
        ...base,
        { id: 't1', type: 'agent.thinking' },
        { id: 't2', type: 'agent.tool_use' },
        { id: 't3', type: 'agent.tool_result' },
        { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '查到了' }] },
        { id: 'i1', type: 'session.status_idle' },
      ],
    ];

    let call = 0;
    const deltas: string[] = [];
    await pollSessionEventsForAgentReply({
      listEvents: async () => rounds[Math.min(call++, rounds.length - 1)],
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      // idleTimeout 设为 0：只要有新事件就必须重置，否则第二轮即抛错
      idleTimeoutMs: 0,
      timeoutMs: 5_000,
    });

    expect(deltas).toEqual(['查到了']);
    expect(call).toBe(4);
  });

  it('无任何新事件时按 idleTimeoutMs 超时', async () => {
    await expect(
      pollSessionEventsForAgentReply({
        listEvents: async () => [{ id: 'e1', type: 'session.status_running' }],
        onDelta: () => {},
        baselineEventIds: new Set(['e1']), // 全部已见 → 永无新事件
        pollIntervalMs: 1,
        idleTimeoutMs: 0,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_REPLY_TIMEOUT' });
  });

  it('持续有新事件但永不 idle 时，由总超时兜底', async () => {
    let n = 0;
    await expect(
      pollSessionEventsForAgentReply({
        // 每轮都产出全新事件 → 无进展计时永不触发，只能靠 timeoutMs 收口
        listEvents: async () => [{ id: `e${n++}`, type: 'agent.thinking' }],
        onDelta: () => {},
        pollIntervalMs: 1,
        idleTimeoutMs: 60_000,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_REPLY_TIMEOUT' });
  });
});
