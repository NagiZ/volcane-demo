import type { ChatMessage } from '../types';

interface MessageItemProps {
  message: ChatMessage;
}

export function MessageItem({ message }: MessageItemProps) {
  if (message.role === 'error') {
    return (
      <article className="bubble bubble--error">
        <p className="bubble__meta">请求出错</p>
        <p className="bubble__code">{message.code ?? 'UNKNOWN'}</p>
        <p className="bubble__text">{message.content}</p>
      </article>
    );
  }

  const side = message.role === 'user' ? 'user' : 'agent';
  const label = message.role === 'user' ? '你' : 'Agent';

  return (
    <article className={`bubble bubble--${side}`}>
      <p className="bubble__meta">{label}</p>
      <p className="bubble__text">{message.content}</p>
    </article>
  );
}
