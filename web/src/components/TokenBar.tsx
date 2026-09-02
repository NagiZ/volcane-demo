import type { BackendStatus } from '../types';

interface TokenBarProps {
  token: string;
  backendStatus: BackendStatus;
  rebuilding: boolean;
  busy: boolean;
  notice: string | null;
  onTokenChange: (value: string) => void;
  onRebuild: () => void;
}

const STATUS_LABEL: Record<BackendStatus, string> = {
  checking: '检测中',
  online: '后端在线',
  offline: '后端离线',
};

export function TokenBar({
  token,
  backendStatus,
  rebuilding,
  busy,
  notice,
  onTokenChange,
  onRebuild,
}: TokenBarProps) {
  return (
    <header className="token-bar">
      <div className="token-bar__brand">
        <span className="token-bar__mark" aria-hidden="true" />
        <div>
          <p className="token-bar__kicker">Ark Managed Agent</p>
          <h1 className="token-bar__title">Volcane</h1>
        </div>
      </div>

      <label className="token-field">
        <span className="token-field__label">webUserToken</span>
        <input
          className="token-field__input"
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <div className="token-bar__actions">
        <span className={`health health--${backendStatus}`}>
          <span className="health__dot" />
          {STATUS_LABEL[backendStatus]}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onRebuild}
          disabled={busy || rebuilding || token.trim().length === 0}
        >
          {rebuilding ? '重建中…' : '重建会话'}
        </button>
      </div>

      {notice ? <p className="token-bar__notice">{notice}</p> : null}
    </header>
  );
}
