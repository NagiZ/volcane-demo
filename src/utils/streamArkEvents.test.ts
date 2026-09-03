import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { pipeArkStreamToSse } from './streamArkEvents.js';

function sseStream(events: unknown[]): IncomingMessage {
  const stream = new PassThrough();
  queueMicrotask(() => {
    for (const event of events) {
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    stream.write(': heartbeat\n\n');
  });
  return stream as unknown as IncomingMessage;
}

describe('pipeArkStreamToSse', () => {
  it('emits every agent.message and returns on session.status_idle', async () => {
    const texts: string[] = [];
    await pipeArkStreamToSse(
      sseStream([
        { type: 'session.status_running' },
        { type: 'agent.message', content: [{ type: 'text', text: '先说明一下' }] },
        { type: 'agent.tool_use' },
        { type: 'agent.message', content: [{ type: 'text', text: '最终结果' }] },
        { type: 'session.status_idle' },
      ]),
      (text) => texts.push(text),
    );

    expect(texts).toEqual(['先说明一下', '最终结果']);
  });
});
