import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../types';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[];
  waiting: boolean;
}

export function MessageList({ messages, waiting }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, waiting]);

  if (messages.length === 0 && !waiting) {
    return (
      <section className="thread thread--empty">
        <p className="empty__eyebrow">观测台已就位</p>
        <h2 className="empty__title">跟 Agent 说第一句话</h2>
        <p className="empty__hint">
          试试：「你好，请用一句话自我介绍」。多轮对话会沿用同一 Session，改 token 会换用户。
        </p>
      </section>
    );
  }

  return (
    <section className="thread">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
      {waiting ? (
        <article className="bubble bubble--agent bubble--pending">
          <p className="bubble__meta">Agent</p>
          <p className="typing">
            <span />
            <span />
            <span />
            正在输入…
          </p>
        </article>
      ) : null}
      <div ref={endRef} />
    </section>
  );
}
