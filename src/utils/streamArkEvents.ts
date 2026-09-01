import type { IncomingMessage } from 'node:http';
import { extractTextDeltaFromArkEvent } from './arkEventParser.js';

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

export async function pipeArkStreamToSse(
  stream: IncomingMessage,
  write: (text: string) => void,
): Promise<void> {
  for await (const event of iterateArkSse(stream)) {
    const delta = extractTextDeltaFromArkEvent(event);
    if (delta) write(delta);
  }
}
