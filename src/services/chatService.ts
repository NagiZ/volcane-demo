import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import {
  ArkApiError,
  listSessionEvents,
  sendSessionEvent,
  tryStreamSessionEvents,
} from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import { sessionEventKey } from '../utils/arkEventParser.js';
import { pollSessionEventsForAgentReply } from '../utils/pollSessionEvents.js';
import { endSse, initSse, writeSseEvent } from '../utils/sse.js';
import { pipeArkStreamToSse } from '../utils/streamArkEvents.js';
import { SessionService } from './sessionService.js';

/**
 * 注意：同一 Ark Session 不支持并发发送两条消息。
 * MVP 不实现排队锁，调用方需避免并行 chat 请求。
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

    res.on('close', () => {
      abortController.abort();
    });

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
