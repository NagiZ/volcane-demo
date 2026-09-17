import { useEffect } from 'react';
import type { ChatMessage } from '../types';

interface MessageItemProps {
  message: ChatMessage;
}

const HIDDEN_CONTENT_RE = /<hidden-content>([\s\S]*?)<\/hidden-content>/gi;

/** 剥离 <hidden-content>…</hidden-content>（含标签），并收集被隐藏的正文 */
function stripHiddenContent(content: string): { visible: string; hiddenContent: string } {
  const parts: string[] = [];
  const visible = content.replace(HIDDEN_CONTENT_RE, (_match, inner: string) => {
    parts.push(inner);
    return '';
  });
  return { visible, hiddenContent: parts.join('\n') };
}

export function MessageItem({ message }: MessageItemProps) {
  const { visible, hiddenContent } = stripHiddenContent(message.content);

  useEffect(() => {
    if (hiddenContent.length > 0) {
      console.log('[hidden-content]', hiddenContent);
    }
  }, [hiddenContent]);

  if (message.role === 'error') {
    return (
      <article className="bubble bubble--error">
        <p className="bubble__meta">请求出错</p>
        <p className="bubble__code">{message.code ?? 'UNKNOWN'}</p>
        <p className="bubble__text">{visible}</p>
      </article>
    );
  }

  const side = message.role === 'user' ? 'user' : 'agent';
  const label = message.role === 'user' ? '你' : 'Agent';
  const attachments = message.attachments ?? [];

  return (
    <article className={`bubble bubble--${side}`}>
      <p className="bubble__meta">{label}</p>
      {visible.length > 0 && <p className="bubble__text">{visible}</p>}
      {attachments.length > 0 && (
        <ul className="bubble__attachments">
          {attachments.map((item) => (
            <li key={item.file_id} className="bubble__attachment">
              {item.name}
              {item.inline ? ' · 直读' : ''}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
