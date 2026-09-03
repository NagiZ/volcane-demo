import { describe, expect, it, vi } from 'vitest';
import type { ArkSessionEvent } from '../types/ark.js';
import type { CustomToolUse } from '../tools/types.js';
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
        { id: 'e3', type: 'agent.message', content: [{ type: 'text', text: '新回复' }] },
        { id: 'e4', type: 'session.status_idle' },
      ],
      baselineEventIds: new Set(['e1']),
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(deltas).toEqual(['新回复']);
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

  it('已答完但方舟未发 idle 时正常结束，不报错', async () => {
    // 复现线上问题：alice 已收到完整答案，却又收到 AGENT_REPLY_TIMEOUT。
    // agent.message 之后永无 idle 事件，应按「已答完」正常返回。
    const events: ArkSessionEvent[] = [
      { id: 'u1', type: 'user.message', content: [{ type: 'text', text: '我的暗号是什么' }] },
      { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '紫色大象' }] },
    ];

    const deltas: string[] = [];
    await pollSessionEventsForAgentReply({
      listEvents: async () => events, // 恒定，不再有新事件，也永不 idle
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      settleAfterReplyMs: 0, // 收到回复后立即收口
      idleTimeoutMs: 60_000,
      timeoutMs: 5_000,
    });

    expect(deltas).toEqual(['紫色大象']);
  });

  it('已答完时优先按已答完收口，而非抛无进展超时', async () => {
    // settleAfterReply 早于 idleTimeout 触发，故不应抛错。
    const events: ArkSessionEvent[] = [
      { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '答案' }] },
    ];
    const deltas: string[] = [];

    await expect(
      pollSessionEventsForAgentReply({
        listEvents: async () => events,
        onDelta: (text) => deltas.push(text),
        pollIntervalMs: 1,
        settleAfterReplyMs: 5,
        idleTimeoutMs: 10, // 比 settle 稍长；若逻辑写反会抛错
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();

    expect(deltas).toEqual(['答案']);
  });

  it('未收到任何回复时仍按无进展超时报错', async () => {
    // 与上一例的区别：无 agent.message → 必须报错，不能被 settle 逻辑吞掉
    await expect(
      pollSessionEventsForAgentReply({
        listEvents: async () => [{ id: 'e1', type: 'session.status_running' }],
        onDelta: () => {},
        baselineEventIds: new Set(['e1']),
        pollIntervalMs: 1,
        settleAfterReplyMs: 0,
        idleTimeoutMs: 0,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_REPLY_TIMEOUT' });
  });

  it('触达总上限时，已有回复则正常收口', async () => {
    let n = 0;
    const deltas: string[] = [];
    // 持续刷新事件（无进展计时永不触发）但永不 idle，只能靠 timeoutMs 收口；
    // 因已产出 agent.message，应正常返回而非报错。
    await expect(
      pollSessionEventsForAgentReply({
        listEvents: async () => [
          { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '答案' }] },
          { id: `t${n++}`, type: 'agent.thinking' },
        ],
        onDelta: (text) => deltas.push(text),
        pollIntervalMs: 1,
        settleAfterReplyMs: 60_000,
        idleTimeoutMs: 60_000,
        timeoutMs: 30,
      }),
    ).resolves.toBeUndefined();

    expect(deltas).toEqual(['答案']);
  });

  it('工具静默执行期间不提前收口（agent.message 后跟 tool_use）', async () => {
    // 复现实测时间线：Agent 先发说明性 message，紧跟 tool_use，
    // 该工具静默执行 30s+ 无任何事件。若仅凭「已有 message」就收口，
    // 会截断回复——必须等 tool_result 回来。
    const mid: ArkSessionEvent[] = [
      { id: 'u1', type: 'user.message', content: [{ type: 'text', text: '跑个命令' }] },
      { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '接下来执行 sleep' }] },
      { id: 'tu1', type: 'agent.tool_use' },
    ];
    const done: ArkSessionEvent[] = [
      ...mid,
      { id: 'tr1', type: 'agent.tool_result' },
      { id: 'm2', type: 'agent.message', content: [{ type: 'text', text: '执行完毕' }] },
      { id: 'i1', type: 'session.status_idle' },
    ];

    // 前若干轮停在 mid（模拟工具静默执行），之后才给出最终结果
    let call = 0;
    const deltas: string[] = [];
    await pollSessionEventsForAgentReply({
      listEvents: async () => (++call < 5 ? mid : done),
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      settleAfterReplyMs: 0, // 即使宽限为 0，也不该在工具未完成时收口
      idleTimeoutMs: 60_000,
      timeoutMs: 5_000,
    });

    // 两段 message 都要拿到，证明没被提前截断
    expect(deltas).toEqual(['接下来执行 sleep', '执行完毕']);
  });

  it('工具未完成时，触达总上限仍按超时报错', async () => {
    // pendingToolCalls > 0 说明回复不完整，不应伪装成成功
    await expect(
      pollSessionEventsForAgentReply({
        listEvents: async () => [
          { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '开始执行' }] },
          { id: 'tu1', type: 'agent.tool_use' }, // 永无 tool_result
        ],
        onDelta: () => {},
        pollIntervalMs: 1,
        settleAfterReplyMs: 0,
        idleTimeoutMs: 60_000,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_REPLY_TIMEOUT' });
  });

  it('持续有新事件但永不 idle 且无回复时，由总超时报错', async () => {
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

  it('收到 user.interrupt 后等到 session.status_idle 即正常收口（无需 agent.message）', async () => {
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'u1', type: 'user.message', content: [{ type: 'text', text: '长任务' }] },
        { id: 'r1', type: 'session.status_running' },
      ])
      .mockResolvedValueOnce([
        { id: 'u1', type: 'user.message', content: [{ type: 'text', text: '长任务' }] },
        { id: 'r1', type: 'session.status_running' },
        { id: 'i1', type: 'user.interrupt' },
        { id: 'idle1', type: 'session.status_idle' },
      ]);

    await expect(
      pollSessionEventsForAgentReply({
        listEvents,
        onDelta: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();

    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  it('user.interrupt 与 idle 分轮到达时仍能收口', async () => {
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'i1', type: 'user.interrupt' }])
      .mockResolvedValueOnce([
        { id: 'i1', type: 'user.interrupt' },
        { id: 'idle1', type: 'session.status_idle' },
      ]);

    await expect(
      pollSessionEventsForAgentReply({
        listEvents,
        onDelta: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('agent.message 与 idle 分轮到达时仍能收口并下发 delta', async () => {
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'u1', type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
        { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '答完了' }] },
      ])
      .mockResolvedValueOnce([
        { id: 'u1', type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
        { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '答完了' }] },
        { id: 'span1', type: 'span.model_request_end' },
        { id: 'idle1', type: 'session.status_idle' },
      ]);

    const deltas: string[] = [];
    await expect(
      pollSessionEventsForAgentReply({
        listEvents,
        onDelta: (text) => deltas.push(text),
        pollIntervalMs: 1,
        settleAfterReplyMs: 60_000,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();

    expect(deltas).toEqual(['答完了']);
  });

  it('同一 agent.message id 内容从空补全后，靠 settle 收口且至少下发全文', async () => {
    // 列表接口偶发先返回空 content 占位；下一轮同 id 带全文时，
    // 因 id 已进 seen，不会再当 newEvent。此场景依赖方舟一次给全量文本；
    // 这里验证「首轮就有全文」的主路径仍正常。
    const listEvents = vi.fn().mockResolvedValueOnce([
      { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '完整答案' }] },
      { id: 'idle1', type: 'session.status_idle' },
    ]);

    const deltas: string[] = [];
    await pollSessionEventsForAgentReply({
      listEvents,
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(deltas).toEqual(['完整答案']);
  });

  it('session 仍 running 时不得因第一条 agent.message 收口，须继续接收后续 message', async () => {
    // 文档：一轮内每个模型请求都会产生一条 buffered agent.message，
    // 必须等到 session.status_idle 才结束。第一条说明性 message 之后
    // 若按 settle 收口，后续回复会被丢掉。
    const first: ArkSessionEvent[] = [
      { id: 'run1', type: 'session.status_running' },
      { id: 'u1', type: 'user.message', content: [{ type: 'text', text: '查一下' }] },
      { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '我先查一下' }] },
    ];
    const rest: ArkSessionEvent[] = [
      ...first,
      { id: 'm2', type: 'agent.message', content: [{ type: 'text', text: '查询结果是 42' }] },
      { id: 'idle1', type: 'session.status_idle' },
    ];
    let call = 0;
    const deltas: string[] = [];

    await pollSessionEventsForAgentReply({
      listEvents: async () => (++call < 5 ? first : rest),
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      settleAfterReplyMs: 0,
      idleTimeoutMs: 60_000,
      timeoutMs: 5_000,
    });

    expect(deltas).toEqual(['我先查一下', '查询结果是 42']);
  });

  it('同一 agent.message id 内容从短变长时下发增量文本', async () => {
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'run1', type: 'session.status_running' },
        { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '你好' }] },
      ])
      .mockResolvedValueOnce([
        { id: 'run1', type: 'session.status_running' },
        { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '你好，这是完整答案' }] },
        { id: 'idle1', type: 'session.status_idle' },
      ]);

    const deltas: string[] = [];
    await pollSessionEventsForAgentReply({
      listEvents,
      onDelta: (text) => deltas.push(text),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(deltas.join('')).toBe('你好，这是完整答案');
  });

  it('仅有 user.message 与晚到的 idle 时不提前收口，避免空 delta 结束', async () => {
    const user: ArkSessionEvent = {
      id: 'u1',
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    };
    const idle: ArkSessionEvent = { id: 'idle1', type: 'session.status_idle' };
    let n = 0;

    await expect(
      pollSessionEventsForAgentReply({
        listEvents: async () => (++n === 1 ? [user] : [user, idle]),
        onDelta: () => {},
        pollIntervalMs: 1,
        idleTimeoutMs: 0,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_REPLY_TIMEOUT' });
  });

  it('requires_action 触发回调且不提前结束，真正 idle 才收口', async () => {
    const pendingSeen: string[][] = [];
    const tools: Array<{ status: string; call_id: string }> = [];
    const deltas: string[] = [];
    const rounds: ArkSessionEvent[][] = [
      [
        { id: 'run1', type: 'session.status_running' },
        {
          id: 'ctu1',
          type: 'agent.custom_tool_use',
          name: 'get_user_order',
          input: { order_id: '1' },
        },
      ],
      [
        { id: 'run1', type: 'session.status_running' },
        {
          id: 'ctu1',
          type: 'agent.custom_tool_use',
          name: 'get_user_order',
          input: { order_id: '1' },
        },
        {
          id: 'idle-ra',
          type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['ctu1'] },
        },
      ],
      [
        { id: 'run2', type: 'session.status_running' },
        { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '订单已付' }] },
        { id: 'idle-done', type: 'session.status_idle' },
      ],
    ];
    let i = 0;
    await pollSessionEventsForAgentReply({
      listEvents: async () => rounds[Math.min(i++, rounds.length - 1)]!,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      onDelta: (text) => deltas.push(text),
      onTool: (ev) => tools.push({ status: ev.status, call_id: ev.call_id }),
      onRequiresAction: async (eventIds, pending: Map<string, CustomToolUse>) => {
        pendingSeen.push([...eventIds]);
        for (const id of eventIds) pending.delete(id);
      },
    });
    expect(pendingSeen).toEqual([['ctu1']]);
    expect(tools.some((t) => t.call_id === 'ctu1' && t.status === 'running')).toBe(true);
    expect(deltas).toEqual(['订单已付']);
  });

  it('requires_action 后 settle 不得提前收口：须等到最终 idle', async () => {
    // 回归：先有 agent.message → custom_tool_use → requires_action idle；
    // 此后若干轮无新事件且 settleAfterReplyMs=0。若未阻塞 settle，
    // 会因 repliedAt + idle lifecycle + pendingToolCalls=0 提前结束，丢掉终态回复。
    const afterRequires: ArkSessionEvent[] = [
      { id: 'run1', type: 'session.status_running' },
      {
        id: 'm0',
        type: 'agent.message',
        content: [{ type: 'text', text: '我先查订单' }],
      },
      {
        id: 'ctu1',
        type: 'agent.custom_tool_use',
        name: 'get_user_order',
        input: { order_id: '1' },
      },
      {
        id: 'idle-ra',
        type: 'session.status_idle',
        stop_reason: { type: 'requires_action', event_ids: ['ctu1'] },
      },
    ];
    const final: ArkSessionEvent[] = [
      ...afterRequires,
      { id: 'run2', type: 'session.status_running' },
      {
        id: 'm1',
        type: 'agent.message',
        content: [{ type: 'text', text: '订单已付' }],
      },
      { id: 'idle-done', type: 'session.status_idle' },
    ];

    let call = 0;
    const deltas: string[] = [];
    let onRequiresActionCalls = 0;

    await pollSessionEventsForAgentReply({
      listEvents: async () => (++call <= 4 ? afterRequires : final),
      pollIntervalMs: 1,
      settleAfterReplyMs: 0,
      idleTimeoutMs: 60_000,
      timeoutMs: 5_000,
      onDelta: (text) => deltas.push(text),
      onRequiresAction: async (eventIds, pending: Map<string, CustomToolUse>) => {
        onRequiresActionCalls++;
        for (const id of eventIds) pending.delete(id);
      },
    });

    expect(onRequiresActionCalls).toBe(1);
    expect(call).toBeGreaterThan(4);
    expect(deltas).toEqual(['我先查订单', '订单已付']);
  });
});
