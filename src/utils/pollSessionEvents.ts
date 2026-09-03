import type { ArkSessionEvent } from '../types/ark.js';
import { ArkApiError } from '../clients/arkClient.js';
import {
  extractTextDeltaFromArkEvent,
  isAgentMessageEvent,
  isSessionIdleEvent,
  isUserInterruptEvent,
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
 * 1. 出现 session.status_idle，且本轮见过 agent.message（可跨轮）或同批 user.message，
 *    或见过 user.interrupt；
 * 2. 已收到 agent.message、其后无未完成的工具调用，且此后 settleAfterReplyMs
 *    内无新事件——方舟有时给出回复后迟迟不发 idle。
 *
 * ⚠️ agent.message 不等于「答完」：多步任务中 Agent 会先发一条说明再调工具，
 * 必须跟踪 tool_use / tool_result 配对。
 */
export async function pollSessionEventsForAgentReply(params: PollSessionEventsParams): Promise<void> {
  const seen = new Set(params.baselineEventIds ?? []);
  const interval = params.pollIntervalMs ?? 500;
  const idleTimeout = params.idleTimeoutMs ?? Number.POSITIVE_INFINITY;
  const settleAfterReply = params.settleAfterReplyMs ?? 8_000;
  const hardDeadline = Date.now() + (params.timeoutMs ?? Number.POSITIVE_INFINITY);
  /** 最近一次拉到新事件的时刻；无进展超时以此为基准。 */
  let lastProgressAt = Date.now();
  /** 本轮是否已见过 agent.message（跨轮 idle 收口用）。 */
  let repliedAt: number | null = null;
  /** 未收到 tool_result 的 tool_use 数；>0 表示 Agent 仍在执行工具，尚未答完。 */
  let pendingToolCalls = 0;
  /** 本轮是否见过 user.interrupt；见到后等 idle 即可收口。 */
  let interrupted = false;

  while (Date.now() < hardDeadline) {
    if (params.signal?.aborted) {
      throw new ArkApiError('Request aborted', { code: 'ABORTED' });
    }

    const events = (await params.listEvents()) ?? [];
    const newEvents = events.filter((event) => !seen.has(sessionEventKey(event)));

    for (const event of newEvents) {
      seen.add(sessionEventKey(event));
      if (event.type === 'agent.tool_use') pendingToolCalls++;
      else if (event.type === 'agent.tool_result') pendingToolCalls = Math.max(0, pendingToolCalls - 1);
      if (isAgentMessageEvent(event)) {
        const text = extractTextDeltaFromArkEvent(event);
        if (text) params.onDelta(text);
      }
      if (isUserInterruptEvent(event)) interrupted = true;
    }

    const hasNewIdle = newEvents.some(isSessionIdleEvent);
    const hasNewAgentMessage = newEvents.some(isAgentMessageEvent);

    const now = Date.now();
    if (hasNewAgentMessage) repliedAt = now;

    // 跨轮：agent.message 已在此前轮次见过时，晚到的 idle 也应收口。
    // 注意：不能仅凭 user.message + idle 收口，否则尚未抽出回复就会 done → 前端 EMPTY_STREAM。
    if (hasNewIdle && (hasNewAgentMessage || repliedAt !== null || interrupted)) {
      return;
    }

    if (newEvents.length > 0) {
      // 任何新事件都算有进展（含 thinking / tool_use / tool_result），重置无进展计时。
      lastProgressAt = now;
    } else if (repliedAt !== null && pendingToolCalls === 0 && now - repliedAt >= settleAfterReply) {
      // 已答完、工具无待完成、只是缺 idle 事件：正常结束，不报错。
      return;
    } else if (now - lastProgressAt >= idleTimeout) {
      throw new ArkApiError(
        `Agent reply timeout: no new events for ${Math.round(idleTimeout / 1000)}s`,
        { code: 'AGENT_REPLY_TIMEOUT' },
      );
    }

    await sleep(interval, params.signal);
  }

  // 触达总上限：若已给出回复且无待完成工具，按已答完收口，
  // 不让用户在看到答案后再收到错误。
  if (repliedAt !== null && pendingToolCalls === 0) return;

  throw new ArkApiError('Agent reply timeout: exceeded overall deadline', {
    code: 'AGENT_REPLY_TIMEOUT',
  });
}
