import { Router, type Request, type Response } from 'express';
import { ArkApiError } from '../clients/arkClient.js';
import type { ChatService } from '../services/chatService.js';
import type { SessionService } from '../services/sessionService.js';

function requireNonEmptyString(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${field} is required`;
  return null;
}

export function createAgentRouter(deps: {
  chatService: ChatService;
  sessionService: SessionService;
}): Router {
  const router = Router();

  router.post('/chat', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    const msgErr = requireNonEmptyString(req.body?.userMessage, 'userMessage');
    if (tokenErr || msgErr) {
      return res.status(400).json({ error: tokenErr ?? msgErr });
    }

    try {
      await deps.chatService.streamChat(res, {
        webUserToken: req.body.webUserToken.trim(),
        userMessage: req.body.userMessage.trim(),
      });
    } catch (err) {
      if (!res.headersSent) {
        return res.status(503).json({
          error: err instanceof Error ? err.message : 'Chat failed',
        });
      }
      if (!res.writableEnded) res.end();
    }
  });

  router.post('/interrupt', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });

    try {
      const result = await deps.chatService.interruptChat(req.body.webUserToken.trim());
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof ArkApiError && err.code === 'NO_SESSION') {
        return res.status(404).json({ error: err.message });
      }
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Interrupt failed',
      });
    }
  });

  router.post('/rebuild-session', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });

    try {
      const result = await deps.sessionService.rebuildSession(req.body.webUserToken.trim());
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Rebuild failed',
      });
    }
  });

  router.get('/messages', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.query?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });

    const rawLimit = req.query?.limit;
    const limit =
      typeof rawLimit === 'string' && rawLimit.trim().length > 0 ? Number(rawLimit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
    }

    try {
      const result = await deps.chatService.listRecentMessages(String(req.query.webUserToken).trim(), {
        limit,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'List messages failed',
      });
    }
  });

  return router;
}
