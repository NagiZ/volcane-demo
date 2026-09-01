import type { Response } from 'express';
import type { NormalizedSseEvent } from '../types/sse.js';

export function initSse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

export function writeSseEvent(res: Response, event: NormalizedSseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function endSse(res: Response): void {
  res.end();
}
