import { useState, type KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const canSend = !disabled && draft.trim().length > 0;

  function submit() {
    const text = draft.trim();
    if (disabled || text.length === 0) return;
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
      <button type="submit" className="btn btn--ember" disabled={!canSend}>
        {disabled ? '等待回复' : '发送'}
      </button>
    </form>
  );
}
