import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { ApiError, uploadAgentFile } from '../api';
import type { ChatAttachment } from '../types';

export interface SendPayload {
  file_ids: string[];
  inline_file_ids: string[];
  file_names: Record<string, string>;
  attachments: ChatAttachment[];
}

interface PendingAttachment {
  localId: string;
  file: File;
  status: 'uploading' | 'ready' | 'error';
  file_id?: string;
  name: string;
  size?: number;
  inline: boolean;
  error?: string;
}

interface ComposerProps {
  webUserToken: string;
  disabled: boolean;
  streaming: boolean;
  interrupting: boolean;
  onSend: (text: string, payload: SendPayload) => void;
  onAbort: () => void;
}

function defaultInline(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  if (file.type === 'application/pdf') return true;
  if (file.type === 'text/plain' || file.type === 'text/markdown') return true;
  if (file.type === 'application/msword') return true;
  if (file.type.startsWith('application/vnd.openxmlformats-officedocument.')) return true;
  return false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Composer({
  webUserToken,
  disabled,
  streaming,
  interrupting,
  onSend,
  onAbort,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasUploading = attachments.some((item) => item.status === 'uploading');
  const readyAttachments = attachments.filter((item) => item.status === 'ready' && item.file_id);
  const canSend =
    !disabled &&
    !streaming &&
    !hasUploading &&
    (draft.trim().length > 0 || readyAttachments.length > 0);

  function startUpload(file: File) {
    const localId = crypto.randomUUID();
    const pending: PendingAttachment = {
      localId,
      file,
      status: 'uploading',
      name: file.name,
      inline: defaultInline(file),
    };

    setAttachments((prev) => [...prev, pending]);

    const trimmedToken = webUserToken.trim();
    if (trimmedToken.length === 0) {
      setAttachments((prev) =>
        prev.map((item) =>
          item.localId === localId
            ? { ...item, status: 'error', error: 'webUserToken 不能为空' }
            : item,
        ),
      );
      return;
    }

    void (async () => {
      try {
        const result = await uploadAgentFile(trimmedToken, file);
        setAttachments((prev) =>
          prev.map((item) =>
            item.localId === localId
              ? {
                  ...item,
                  status: 'ready',
                  file_id: result.file_id,
                  name: result.name,
                  size: result.size,
                }
              : item,
          ),
        );
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '上传失败';
        setAttachments((prev) =>
          prev.map((item) =>
            item.localId === localId ? { ...item, status: 'error', error: message } : item,
          ),
        );
      }
    })();
  }

  function onFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;
    for (const file of files) {
      startUpload(file);
    }
    event.target.value = '';
  }

  function removeAttachment(localId: string) {
    setAttachments((prev) => prev.filter((item) => item.localId !== localId));
  }

  function toggleInline(localId: string) {
    setAttachments((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, inline: !item.inline } : item)),
    );
  }

  function buildPayload(): SendPayload {
    const file_ids: string[] = [];
    const inline_file_ids: string[] = [];
    const file_names: Record<string, string> = {};
    const chatAttachments: ChatAttachment[] = [];

    for (const item of readyAttachments) {
      if (!item.file_id) continue;
      file_ids.push(item.file_id);
      file_names[item.file_id] = item.name;
      if (item.inline) inline_file_ids.push(item.file_id);
      chatAttachments.push({ file_id: item.file_id, name: item.name, inline: item.inline });
    }

    return { file_ids, inline_file_ids, file_names, attachments: chatAttachments };
  }

  function submit() {
    if (!canSend) return;
    const text = draft.trim();
    const payload = buildPayload();
    if (text.length === 0 && payload.file_ids.length === 0) return;
    onSend(text, payload);
    setDraft('');
    setAttachments([]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  const attachmentsDisabled = disabled || streaming;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {attachments.length > 0 && (
        <div className="composer__chips">
          {attachments.map((item) => (
            <div
              key={item.localId}
              className={`chip${item.status === 'error' ? ' chip--error' : ''}`}
            >
              <span className="chip__name" title={item.name}>
                {item.name}
              </span>
              {item.size != null && <span className="chip__size">{formatSize(item.size)}</span>}
              <span className="chip__status">
                {item.status === 'uploading' && '上传中…'}
                {item.status === 'ready' && '就绪'}
                {item.status === 'error' && (item.error ?? '失败')}
              </span>
              {item.status === 'ready' && (
                <label className="chip__inline">
                  <input
                    type="checkbox"
                    checked={item.inline}
                    disabled={attachmentsDisabled}
                    onChange={() => toggleInline(item.localId)}
                  />
                  模型直读
                </label>
              )}
              <button
                type="button"
                className="chip__remove"
                disabled={attachmentsDisabled}
                onClick={() => removeAttachment(item.localId)}
                aria-label={`移除 ${item.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer__row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          disabled={attachmentsDisabled}
          onChange={onFilesSelected}
        />
        <button
          type="button"
          className="composer__attach btn btn--ghost"
          disabled={attachmentsDisabled}
          onClick={() => fileInputRef.current?.click()}
        >
          附件
        </button>
        <textarea
          className="composer__input"
          rows={3}
          cols={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入消息。⌘/Ctrl+Enter 发送，Enter 换行"
        />
        {streaming ? (
          <button type="button" className="btn btn--abort" onClick={onAbort} disabled={interrupting}>
            {interrupting ? '中止中…' : '中止'}
          </button>
        ) : (
          <button type="submit" className="btn btn--ember" disabled={!canSend}>
            发送
          </button>
        )}
      </div>
    </form>
  );
}
