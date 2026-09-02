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
  /**
   * 已收到 agent.message 且其后无待完成工具调用时，等待 session.status_idle 的宽限时长。
   * 超过则视为本轮已答完并正常结束——方舟有时迟迟不发 idle 事件。
   */
  settleAfterReplyMs?: number;
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
 * 终止条件（任一成立即正常返回）：
 * 1. 出现 session.status_idle，且本轮有 agent.message 或 user.message；
 * 2. 已收到 agent.message、其后无未完成的工具调用，且此后 settleAfterReplyMs
 *    内无新事件——方舟有时给出回复后迟迟不发 idle，若仍等到 idleTimeout 才收口，
 *    用户会在看到完整答案后又收到一个 AGENT_REPLY_TIMEOUT 错误。
 *
 * ⚠️ agent.message 不等于「答完」：多步任务中 Agent 会先发一条说明再调工具
 * （实测 tool_use 可静默执行 30s+ 无任何事件）。因此必须跟踪 tool_use /
 * tool_result 配对，工具仍在执行时不启用条件 2，否则会提前截断回复。
 *
 * 超时语义（两级，且仅在**未收到任何回复**时才算失败）：
 * - idleTimeoutMs：**无进展**超时。只要本轮拉到任何新事件就重置。
 *   Agent 多轮 tool_use 期间会持续产出 thinking/tool_use/tool_result 事件，
 *   因此不会被误判为卡死——这是本函数不使用「固定总超时」的原因。
 * - timeoutMs：总耗时兜底上限，防止 Agent 持续刷事件却永不 idle 时无限轮询。
 */
export async function pollSessionEventsForAgentReply(params: PollSessionEventsParams): Promise<void> {
  const seen = new Set(params.baselineEventIds ?? []);
  const interval = params.pollIntervalMs ?? 500;
  const idleTimeout = params.idleTimeoutMs ?? 60_000;
  const settleAfterReply = params.settleAfterReplyMs ?? 8_000;
  const hardDeadline = Date.now() + (params.timeoutMs ?? 600_000);
  /** 最近一次拉到新事件的时刻；无进展超时以此为基准。 */
  let lastProgressAt = Date.now();
  /** 本轮是否已产出过 agent.message——决定超时是「失败」还是「已答完」。 */
  let repliedAt: number | null = null;
  /** 未收到 tool_result 的 tool_use 数；>0 表示 Agent 仍在执行工具，尚未答完。 */
  let pendingToolCalls = 0;

  while (Date.now() < hardDeadline) {
    if (params.signal?.aborted) {
      throw new ArkApiError('Request aborted', { code: 'ABORTED' });
    }

    const events = await params.listEvents();
    const newEvents = events.filter((event) => !seen.has(sessionEventKey(event)));

    for (const event of newEvents) {
      seen.add(sessionEventKey(event));
      if (event.type === 'agent.tool_use') pendingToolCalls++;
      else if (event.type === 'agent.tool_result') pendingToolCalls = Math.max(0, pendingToolCalls - 1);
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

    const now = Date.now();
    if (hasNewAgentMessage) repliedAt = now;

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
