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
 * 终止条件：本轮出现 session.status_idle，且已投递的 user.message 之后有 agent.message；
 * 或 idle 且无 agent 回复（Agent 异常结束）。
 */
export async function pollSessionEventsForAgentReply(params: PollSessionEventsParams): Promise<void> {
  const seen = new Set(params.baselineEventIds ?? []);
  const deadline = Date.now() + (params.timeoutMs ?? 120_000);
  const interval = params.pollIntervalMs ?? 500;

  while (Date.now() < deadline) {
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

    await sleep(interval, params.signal);
  }

  throw new ArkApiError('Agent reply timeout', { code: 'AGENT_REPLY_TIMEOUT' });
}
