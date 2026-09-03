import type { IncomingMessage } from 'node:http';
import { extractTextDeltaFromArkEvent, isSessionIdleEvent } from './arkEventParser.js';

export async function* iterateArkSse(stream: IncomingMessage): AsyncGenerator<unknown> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

/**
 * 消费官方 GET /events/stream。
 * 文档：一轮内会有多条 buffered agent.message，读到 session.status_idle 才结束。
 * 忽略 event_delta 预览，以完整 agent.message 为准，避免重复下发。
 */
export async function pipeArkStreamToSse(
  stream: IncomingMessage,
  write: (text: string) => void,
): Promise<void> {
  for await (const event of iterateArkSse(stream)) {
    if (isSessionIdleEvent(event)) {
      stream.destroy?.();
      return;
    }
    if (!event || typeof event !== 'object') continue;
    const type = (event as Record<string, unknown>).type;
    if (type !== 'agent.message') continue;
    const delta = extractTextDeltaFromArkEvent(event);
    if (delta) write(delta);
  }
}
