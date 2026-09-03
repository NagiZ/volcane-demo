import { useState, type KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean;
  streaming: boolean;
  interrupting: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({ disabled, streaming, interrupting, onSend, onAbort }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const canSend = !disabled && !streaming && draft.trim().length > 0;

  function submit() {
    const text = draft.trim();
    if (disabled || streaming || text.length === 0) return;
    onSend(text);
    setDraft('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="composer__input"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="输入消息。Enter 发送，Shift+Enter 换行"
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
    </form>
  );
}
