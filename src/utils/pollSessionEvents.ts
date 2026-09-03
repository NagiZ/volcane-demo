import type { ArkSessionEvent } from '../types/ark.js';
import { ArkApiError } from '../clients/arkClient.js';
import {
  extractTextDeltaFromArkEvent,
  isAgentMessageEvent,
  isSessionIdleEvent,
  isToolResultEvent,
  isToolUseEvent,
  isUserInterruptEvent,
  latestSessionLifecycle,
  sessionEventKey,
} from './arkEventParser.js';

export interface PollSessionEventsParams {
  listEvents: () => Promise<ArkSessionEvent[]>;
  onDelta: (text: string) => void;
  baselineEventIds?: Set<string>;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /**
   * 无任何新事件的最长等待（判定 Agent 卡死）。有新事件即重置。
   * 默认不限制；传有限值时才启用。0 表示立刻判定超时（便于单测）。
   */
  idleTimeoutMs?: number;
  /**
   * 已收到 agent.message 且其后无待完成工具调用时，等待 session.status_idle 的宽限时长。
   * 超过则视为本轮已答完并正常结束——方舟有时迟迟不发 idle 事件。
   */
  settleAfterReplyMs?: number;
  /**
   * 单轮对话总耗时上限。默认不限制；传有限值时才启用。
   * 生产环境依赖 AbortSignal / 客户端断开收口。
   */
  timeoutMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ArkApiError('Request aborted', { code: 'ABORTED' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ArkApiError('Request aborted', { code: 'ABORTED' }));
      },
      { once: true },
    );
  });
}

/**
 * POST 投递后轮询「查询会话事件列表」，将新增 agent.message 转为 SSE delta。
 *
 * 终止条件（任一成立即正常返回）：
 * 1. 出现 session.status_idle，且本轮见过 agent.message 或 user.interrupt；
 * 2. 已收到 agent.message、其后无未完成的工具调用，会话已不在 running，
 *    且此后 settleAfterReplyMs 内无新事件——方舟有时给出回复后迟迟不发 idle。
 *
 * ⚠️ 一轮内每个模型请求都会产生一条 agent.message。第一条不等于答完，
 * 会话仍为 session.status_running 时不得收口。
 * 必须跟踪 tool_use / tool_result（含 mcp 变体）配对。
 */
export async function pollSessionEventsForAgentReply(params: PollSessionEventsParams): Promise<void> {
  const seen = new Set(params.baselineEventIds ?? []);
  const interval = params.pollIntervalMs ?? 500;
  const idleTimeout = params.idleTimeoutMs ?? Number.POSITIVE_INFINITY;
  const settleAfterReply = params.settleAfterReplyMs ?? 8_000;
  const hardDeadline = Date.now() + (params.timeoutMs ?? Number.POSITIVE_INFINITY);
  /** 最近一次拉到新事件的时刻；无进展超时以此为基准。 */
  let lastProgressAt = Date.now();
  /** 本轮是否已见过可展示回复（跨轮 idle 收口用）。 */
  let repliedAt: number | null = null;
  /** 未收到 tool_result 的 tool_use 数；>0 表示 Agent 仍在执行工具，尚未答完。 */
  let pendingToolCalls = 0;
  /** 本轮是否见过 user.interrupt；见到后等 idle 即可收口。 */
  let interrupted = false;
  /** 已向下游写出的 agent.message 全文，用于同 id 内容补全时只推增量。 */
  const emittedTextById = new Map<string, string>();

  while (Date.now() < hardDeadline) {
    if (params.signal?.aborted) {
      throw new ArkApiError('Request aborted', { code: 'ABORTED' });
    }

    const events = (await params.listEvents()) ?? [];
    const newEvents = events.filter((event) => !seen.has(sessionEventKey(event)));

    for (const event of events) {
      if (!isAgentMessageEvent(event)) continue;
      const key = sessionEventKey(event);
      const text = extractTextDeltaFromArkEvent(event);
      if (!text) continue;
      const prev = emittedTextById.get(key);
      if (prev === undefined && seen.has(key)) {
        emittedTextById.set(key, text);
        continue;
      }
      if (text === prev) continue;
      const chunk = text.startsWith(prev ?? '') ? text.slice((prev ?? '').length) : text;
      if (chunk) params.onDelta(chunk);
      emittedTextById.set(key, text);
      repliedAt = Date.now();
    }

    for (const event of newEvents) {
      seen.add(sessionEventKey(event));
      if (isToolUseEvent(event)) pendingToolCalls++;
      else if (isToolResultEvent(event)) pendingToolCalls = Math.max(0, pendingToolCalls - 1);
      if (isUserInterruptEvent(event)) interrupted = true;
    }

    const hasNewIdle = newEvents.some(isSessionIdleEvent);
    const sessionLifecycle = latestSessionLifecycle(events);

    const now = Date.now();

    // 文档：读到 session.status_idle 才结束本轮；仍 running 时继续收后续 agent.message。
    if (hasNewIdle && (repliedAt !== null || interrupted)) {
      return;
    }

    if (newEvents.length > 0) {
      lastProgressAt = now;
    } else if (
      repliedAt !== null &&
      pendingToolCalls === 0 &&
      sessionLifecycle !== 'running' &&
      now - repliedAt >= settleAfterReply
    ) {
      return;
    } else if (now - lastProgressAt >= idleTimeout) {
      throw new ArkApiError(
        `Agent reply timeout: no new events for ${Math.round(idleTimeout / 1000)}s`,
        { code: 'AGENT_REPLY_TIMEOUT' },
      );
    }

    await sleep(interval, params.signal);
  }

  if (repliedAt !== null && pendingToolCalls === 0) return;

  throw new ArkApiError('Agent reply timeout: exceeded overall deadline', {
    code: 'AGENT_REPLY_TIMEOUT',
  });
}
