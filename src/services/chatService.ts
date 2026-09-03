import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import {
  ArkApiError,
  listSessionEvents,
  sendSessionEvent,
  sendSessionInterrupt,
  tryStreamSessionEvents,
} from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import { sessionEventKey } from '../utils/arkEventParser.js';
import { pollSessionEventsForAgentReply } from '../utils/pollSessionEvents.js';
import { endSse, initSse, writeSseEvent } from '../utils/sse.js';
import { pipeArkStreamToSse } from '../utils/streamArkEvents.js';
import { SessionService } from './sessionService.js';

/**
 * 注意：同一 Ark Session 不支持并发发送两条 user.message。
 * MVP 不实现排队锁，调用方需避免并行 chat 请求。
 * user.interrupt 是官方允许的例外：可在 Agent 执行中投递以暂停任务。
 */
export class ChatService {
  constructor(
    private readonly config: AppConfig,
    private readonly sessionService: SessionService,
  ) {}

  private arkListParams(sessionId: string, signal?: AbortSignal) {
    return {
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      sessionId,
      signal,
    };
  }

  private async streamOnce(sessionId: string, userMessage: string, res: Response): Promise<void> {
    const abortController = new AbortController();
    const signal = abortController.signal;
    let settled = false;

    // 注意：必须用 req.close，且检查 writableEnded。
    // res.close 在 SSE 场景下会误触发，导致轮询被 abort、前端 EMPTY_STREAM，
    // 而方舟侧 Agent 仍继续跑完（控制台看得到 agent.message）。
    const onClientGone = () => {
      if (settled || res.writableEnded) return;
      abortController.abort();
      void sendSessionInterrupt({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        sessionId,
      }).catch(() => {
        // 连接已断，中断失败不影响本请求
      });
    };
    res.req.on('close', onClientGone);

    try {
      const baselineEvents = await listSessionEvents(this.arkListParams(sessionId, signal));
      const baselineEventIds = new Set(baselineEvents.map((event) => sessionEventKey(event)));

      await sendSessionEvent({
        ...this.arkListParams(sessionId, signal),
        userMessage,
      });

      const stream = await tryStreamSessionEvents(this.arkListParams(sessionId, signal));
      if (stream) {
        let gotContent = false;
        await pipeArkStreamToSse(stream as unknown as IncomingMessage, (text) => {
          gotContent = true;
          writeSseEvent(res, { type: 'delta', text });
        });
        if (gotContent) return;
        (stream as Readable).destroy?.();
      }

      await pollSessionEventsForAgentReply({
        listEvents: () => listSessionEvents(this.arkListParams(sessionId, signal)),
        baselineEventIds,
        onDelta: (text) => writeSseEvent(res, { type: 'delta', text }),
        signal,
      });
    } finally {
      settled = true;
      res.req.off('close', onClientGone);
    }
  }

  /**
   * 向当前 Session 投递 user.interrupt。
   * 不中断正在进行的 chat SSE：轮询侧见到 interrupt + idle 后会自行 done。
   */
  async interruptChat(webUserToken: string): Promise<{ sessionId: string }> {
    const session = await this.sessionService.getExistingSession(webUserToken);
    if (!session) {
      throw new ArkApiError('No active session to interrupt', { code: 'NO_SESSION' });
    }
    await sendSessionInterrupt({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      sessionId: session.sessionId,
    });
    return { sessionId: session.sessionId };
  }

  async streamChat(
    res: Response,
    input: { webUserToken: string; userMessage: string },
  ): Promise<void> {
    let session = await this.sessionService.getOrCreateSession(input.webUserToken);

    initSse(res);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.streamOnce(session.sessionId, input.userMessage, res);
        writeSseEvent(res, { type: 'done' });
        endSse(res);
        return;
      } catch (err) {
        const arkErr = err instanceof ArkApiError ? err : new ArkApiError(String(err));
        // 客户端断开：直接结束，勿再写 error（连接可能已不可写）
        if (arkErr.code === 'ABORTED' || res.destroyed || res.writableEnded) {
          if (!res.writableEnded) {
            writeSseEvent(res, { type: 'done' });
            endSse(res);
          }
          return;
        }
        const canRetry = attempt === 0 && arkErr.isSessionNotFound;
        if (canRetry) {
          try {
            session = await this.sessionService.invalidateAndRecreate(input.webUserToken);
          } catch (recreateErr) {
            const recreateArkErr =
              recreateErr instanceof ArkApiError ? recreateErr : new ArkApiError(String(recreateErr));
            writeSseEvent(res, {
              type: 'error',
              code: recreateArkErr.code ?? 'SESSION_RECREATE_FAILED',
              message: recreateArkErr.message,
            });
            endSse(res);
            return;
          }
          continue;
        }
        writeSseEvent(res, {
          type: 'error',
          code: arkErr.code ?? 'ARK_ERROR',
          message: arkErr.message,
        });
        endSse(res);
        return;
      }
    }
  }
}
