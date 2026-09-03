import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { ArkApiError } from '../clients/arkClient.js';
import type { ChatService } from '../services/chatService.js';
import type { FileService } from '../services/fileService.js';
import type { SessionService } from '../services/sessionService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

function requireNonEmptyString(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${field} is required`;
  return null;
}

export function createAgentRouter(deps: {
  chatService: ChatService;
  sessionService: SessionService;
  fileService: FileService;
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

  router.post('/upload-file', (req: Request, res: Response, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: '文件过大，最大 512MB' });
      }
      if (err) return res.status(400).json({ error: err instanceof Error ? err.message : '上传失败' });
      return next();
    });
  }, async (req: Request, res: Response) => {
    const token =
      (typeof req.body?.webUserToken === 'string' && req.body.webUserToken.trim()) ||
      '';
    if (!token) return res.status(400).json({ error: 'webUserToken is required' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    try {
      const info = await deps.fileService.uploadUserFile(token, req.file);
      return res.status(200).json({
        file_id: info.file_id,
        name: info.name,
        size: info.size,
      });
    } catch (err) {
      const arkErr = err instanceof ArkApiError ? err : null;
      const status = arkErr?.status === 413 ? 413 : arkErr?.status === 400 ? 400 : 502;
      return res.status(status).json({
        error: err instanceof Error ? err.message : '文件上传失败',
      });
    }
  });

  router.get('/output-files', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.query?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });
    try {
      const result = await deps.fileService.listOutputFiles(String(req.query.webUserToken).trim());
      return res.status(200).json({
        ok: true,
        sessionId: result.sessionId,
        files: result.files.map((f) => ({
          file_id: f.file_id,
          name: f.name,
          size: f.size,
          download_url: f.download_url ?? null,
        })),
      });
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'List output files failed',
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
