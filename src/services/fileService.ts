import { ArkApiError, listSessionOutputFiles, uploadArkFile } from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import type { ArkFileInfo } from '../types/ark.js';
import { SessionService } from './sessionService.js';

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export class FileService {
  constructor(
    private readonly config: AppConfig,
    private readonly sessionService: SessionService,
  ) {}

  async uploadUserFile(
    webUserToken: string,
    file: { buffer: Buffer; originalname: string; mimetype?: string; size: number },
  ): Promise<ArkFileInfo> {
    if (!webUserToken.trim()) {
      throw new ArkApiError('webUserToken is required', { code: 'BAD_REQUEST', status: 400 });
    }
    if (!file?.buffer?.length) {
      throw new ArkApiError('file is required', { code: 'BAD_REQUEST', status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ArkApiError('文件过大，最大 512MB', { code: 'FILE_TOO_LARGE', status: 413 });
    }
    return uploadArkFile({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      fileBuffer: file.buffer,
      originalName: file.originalname || 'file',
      contentType: file.mimetype,
    });
  }

  async listOutputFiles(
    webUserToken: string,
  ): Promise<{ sessionId: string | null; files: ArkFileInfo[] }> {
    const session = await this.sessionService.getExistingSession(webUserToken);
    if (!session) return { sessionId: null, files: [] };
    const files = await listSessionOutputFiles({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      scopeId: session.sessionId,
    });
    return { sessionId: session.sessionId, files };
  }
}
