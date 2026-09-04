import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchOutputFiles } from '../api';
import type { OutputFileItem } from '../types';

interface OutputFilesBarProps {
  token: string;
  disabled: boolean;
  refreshToken: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function OutputFilesBar({ token, disabled, refreshToken }: OutputFilesBarProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [files, setFiles] = useState<OutputFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      setFiles([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await fetchOutputFiles(trimmed, signal);
      if (signal?.aborted) return;
      setFiles(result.files);
    } catch (err) {
      if (signal?.aborted) return;
      const message = err instanceof ApiError ? err.message : '拉取产物失败';
      setError(message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshToken]);

  return (
    <section className="output-files">
      <header className="output-files__header">
        <button
          type="button"
          className="output-files__toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <span className="output-files__title">Agent 产物</span>
          <span className="output-files__count">{files.length > 0 ? `(${files.length})` : ''}</span>
          <span className="output-files__chevron" aria-hidden>
            {collapsed ? '▸' : '▾'}
          </span>
        </button>
        <button
          type="button"
          className="btn btn--ghost output-files__refresh"
          onClick={() => void load()}
          disabled={disabled || loading || token.trim().length === 0}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </header>

      {!collapsed && (
        <div className="output-files__body">
          {error ? (
            <p className="output-files__empty">{error}</p>
          ) : files.length === 0 ? (
            <p className="output-files__empty">暂无产物文件</p>
          ) : (
            <ul className="output-files__list">
              {files.map((file) => (
                <li key={file.file_id} className="output-files__item">
                  <span className="output-files__name">{file.name}</span>
                  <span className="output-files__size">{formatSize(file.size)}</span>
                  {file.download_url ? (
                    <a
                      className="output-files__link"
                      href={file.download_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      下载
                    </a>
                  ) : (
                    <span className="output-files__link output-files__link--muted">无链接</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
