import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import {
  ArkApiError,
  getArkFile,
  listRecentSessionEvents,
  listSessionEvents,
  mountFileToSession,
  sendCustomToolResults,
  sendSessionEvent,
  sendSessionInterrupt,
  tryStreamSessionEvents,
} from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import { executeCustomTools } from '../tools/executeCustomTools.js';
import {
  allocateMountBasenames,
  arkMountPath,
  sandboxUploadPath,
} from '../utils/mountPath.js';
import { sessionEventKey } from '../utils/arkEventParser.js';
import { pollSessionEventsForAgentReply } from '../utils/pollSessionEvents.js';
import { SESSION_HISTORY_LIMIT, toChronologicalChatMessages, type ChatHistoryMessage } from '../utils/sessionHistory.js';
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

  private async resolveFileName(
    fileId: string,
    fileNames: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const fromClient = fileNames?.[fileId]?.trim();
    if (fromClient) return fromClient;
    const info = await getArkFile({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      fileId,
      signal,
    });
    return info.name || fileId;
  }

  private async mountFilesToSession(
    sessionId: string,
    fileIds: string[],
    fileNames: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const named = [];
    for (const fileId of fileIds) {
      const name = await this.resolveFileName(fileId, fileNames, signal);
      named.push({ fileId, name });
    }
    const basenames = allocateMountBasenames(named);
    const sandboxPaths: string[] = [];
    for (const { fileId } of named) {
      const basename = basenames.get(fileId)!;
      await mountFileToSession({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        sessionId,
        fileId,
        mountPath: arkMountPath(basename),
        signal,
      });
      sandboxPaths.push(sandboxUploadPath(basename));
    }
    return sandboxPaths;
  }

  private async streamOnce(
    sessionId: string,
    userMessage: string,
    res: Response,
    options?: { mountedPaths?: string[]; inlineFileIds?: string[]; userId: string },
  ): Promise<void> {
    const abortController = new AbortController();
    const signal = abortController.signal;
    const userId = options?.userId ?? '';
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

      // 文档要求先连 GET /events/stream 再投递 user.message，否则会丢掉本轮事件。
      const stream = await tryStreamSessionEvents(this.arkListParams(sessionId, signal));
      try {
        const piped = stream
          ? pipeArkStreamToSse(stream as unknown as IncomingMessage, (text) => {
              writeSseEvent(res, { type: 'delta', text });
            })
          : null;

        await sendSessionEvent({
          ...this.arkListParams(sessionId, signal),
          userMessage,
          mountedPaths: options?.mountedPaths,
          inlineFileIds: options?.inlineFileIds,
        });

        if (piped) {
          await piped;
          return;
        }

        await pollSessionEventsForAgentReply({
          listEvents: () => listSessionEvents(this.arkListParams(sessionId, signal)),
          baselineEventIds,
          onDelta: (text) => writeSseEvent(res, { type: 'delta', text }),
          onTool: (ev) => writeSseEvent(res, { type: 'tool', ...ev }),
          onRequiresAction: async (eventIds, pending) => {
            const snapshot = eventIds.map((id) => ({
              id,
              name: pending.get(id)?.name ?? 'unknown',
            }));
            const results = await executeCustomTools({ eventIds, pending, userId });
            for (let i = 0; i < results.length; i++) {
              const r = results[i]!;
              const meta = snapshot[i]!;
              writeSseEvent(res, {
                type: 'tool',
                tool_name: meta.name,
                call_id: r.custom_tool_use_id,
                status: r.is_error ? 'error' : 'done',
                ...(r.is_error
                  ? { message: r.content[0]?.text ?? 'tool error' }
                  : {}),
              });
            }
            await sendCustomToolResults({
              arkApiKey: this.config.arkApiKey,
              arkBaseUrl: this.config.arkBaseUrl,
              sessionId,
              results,
              signal,
            });
          },
          signal,
        });
      } finally {
        (stream as Readable | null)?.destroy?.();
      }
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
    input: {
      webUserToken: string;
      userMessage: string;
      fileIds?: string[];
      inlineFileIds?: string[];
      fileNames?: Record<string, string>;
    },
  ): Promise<void> {
    let session = await this.sessionService.getOrCreateSession(input.webUserToken);

    initSse(res);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let mountedPaths: string[] | undefined;
        if (input.fileIds?.length) {
          mountedPaths = await this.mountFilesToSession(
            session.sessionId,
            input.fileIds,
            input.fileNames,
          );
        }
        await this.streamOnce(session.sessionId, input.userMessage, res, {
          mountedPaths,
          inlineFileIds: input.inlineFileIds,
          userId: session.tokenHash,
        });
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

  /**
   * 读取当前 token 对应 Session 的最近消息窗口。
   * 无 Session 时返回空列表，不创建新会话。
   */
  async listRecentMessages(
    webUserToken: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<{ sessionId: string | null; messages: ChatHistoryMessage[] }> {
    const session = await this.sessionService.getExistingSession(webUserToken);
    if (!session) {
      return { sessionId: null, messages: [] };
    }
    try {
      const events = await listRecentSessionEvents({
        ...this.arkListParams(session.sessionId, options?.signal),
        limit: options?.limit ?? SESSION_HISTORY_LIMIT,
      });
      return {
        sessionId: session.sessionId,
        messages: toChronologicalChatMessages(events),
      };
    } catch (err) {
      if (err instanceof ArkApiError && err.isSessionNotFound) {
        return { sessionId: session.sessionId, messages: [] };
      }
      throw err;
    }
  }
}
