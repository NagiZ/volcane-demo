/**
 * 从方舟 Session 事件 content 字段提取文本。
 */
export function extractTextFromEventContent(content: unknown): string | null {
  if (typeof content === 'string' && content.length > 0) {
    return content;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (
      (block.type === 'text' || block.type === 'output_text') &&
      typeof block.text === 'string' &&
      block.text.length > 0
    ) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

/**
 * 从方舟 Session 事件 JSON 中提取可展示文本。
 * - agent.message：用户可见回复
 * - agent.thinking / 工具与状态事件：过滤
 * - 流式 SSE 增量字段 delta/text：兼容「流式获取会话事件」
 */
export function extractTextDeltaFromArkEvent(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : '';

  if (type === 'agent.thinking') return null;
  if (type === 'agent.message') {
    return extractTextFromEventContent(event.content);
  }

  if (typeof event.delta === 'string' && event.delta.length > 0) {
    return event.delta;
  }
  if (typeof event.text === 'string' && event.text.length > 0) {
    return event.text;
  }

  return extractTextFromEventContent(event.content);
}

/** 是否为用户可见的 agent 回复事件 */
export function isAgentMessageEvent(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'agent.message');
}

/** 是否为会话进入 idle 的状态事件 */
export function isSessionIdleEvent(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'session.status_idle');
}

/** 生成事件去重 key（优先 id） */
export function sessionEventKey(event: { id?: string; type?: string; content?: unknown }): string {
  if (event.id) return event.id;
  return `${event.type ?? 'unknown'}:${JSON.stringify(event.content ?? null)}`;
}
