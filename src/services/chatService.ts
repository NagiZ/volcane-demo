import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import { ArkApiError, sendSessionEvent } from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
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

  private async streamOnce(sessionId: string, userMessage: string, res: Response): Promise<void> {
    const upstream = (await sendSessionEvent({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      sessionId,
      userMessage,
    })) as Readable;

    res.on('close', () => {
      upstream.destroy();
    });

    await pipeArkStreamToSse(upstream as unknown as IncomingMessage, (text) => {
      writeSseEvent(res, { type: 'delta', text });
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
