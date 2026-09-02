import type { ArkSessionEvent } from '../types/ark.js';
import { ArkApiError } from '../clients/arkClient.js';
import {
  extractTextDeltaFromArkEvent,
  isAgentMessageEvent,
  isSessionIdleEvent,
  sessionEventKey,
} from './arkEventParser.js';

export interface PollSessionEventsParams {
  listEvents: () => Promise<ArkSessionEvent[]>;
  onDelta: (text: string) => void;
  baselineEventIds?: Set<string>;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** 无任何新事件的最长等待（判定 Agent 卡死）。有新事件即重置。 */
  idleTimeoutMs?: number;
  /** 单轮对话总耗时上限（兜底，防止无限轮询）。 */
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
 * 终止条件：本轮出现 session.status_idle，且已投递的 user.message 之后有 agent.message；
 * 或 idle 且无 agent 回复（Agent 异常结束）。
 *
 * 超时语义（两级）：
 * - idleTimeoutMs：**无进展**超时。只要本轮拉到任何新事件就重置。
 *   Agent 多轮 tool_use 期间会持续产出 thinking/tool_use/tool_result 事件，
 *   因此不会被误判为卡死——这是本函数不使用「固定总超时」的原因。
 * - timeoutMs：总耗时兜底上限，防止 Agent 持续刷事件却永不 idle 时无限轮询。
 */
export async function pollSessionEventsForAgentReply(params: PollSessionEventsParams): Promise<void> {
  const seen = new Set(params.baselineEventIds ?? []);
  const interval = params.pollIntervalMs ?? 500;
  const idleTimeout = params.idleTimeoutMs ?? 60_000;
  const hardDeadline = Date.now() + (params.timeoutMs ?? 600_000);
  /** 最近一次拉到新事件的时刻；无进展超时以此为基准。 */
  let lastProgressAt = Date.now();

  while (Date.now() < hardDeadline) {
    if (params.signal?.aborted) {
      throw new ArkApiError('Request aborted', { code: 'ABORTED' });
    }

    const events = await params.listEvents();
    const newEvents = events.filter((event) => !seen.has(sessionEventKey(event)));

    for (const event of newEvents) {
      seen.add(sessionEventKey(event));
      if (isAgentMessageEvent(event)) {
        const text = extractTextDeltaFromArkEvent(event);
        if (text) params.onDelta(text);
      }
    }

    const hasNewIdle = newEvents.some(isSessionIdleEvent);
    const hasNewAgentMessage = newEvents.some(isAgentMessageEvent);
    const hasNewUserMessage = newEvents.some((e) => e.type === 'user.message');

    if (hasNewIdle && (hasNewAgentMessage || hasNewUserMessage)) {
      return;
    }

    // 任何新事件都算有进展（含 thinking / tool_use / tool_result），重置无进展计时。
    if (newEvents.length > 0) {
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= idleTimeout) {
      throw new ArkApiError(
        `Agent reply timeout: no new events for ${Math.round(idleTimeout / 1000)}s`,
        { code: 'AGENT_REPLY_TIMEOUT' },
      );
    }

    await sleep(interval, params.signal);
  }

  throw new ArkApiError('Agent reply timeout: exceeded overall deadline', {
    code: 'AGENT_REPLY_TIMEOUT',
  });
}
