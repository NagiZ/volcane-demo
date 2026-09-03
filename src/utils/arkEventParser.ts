/**
 * 从方舟 Session 事件 content 字段提取文本。
 */
export function extractTextFromEventContent(content: unknown): string | null {
  if (typeof content === 'string' && content.length > 0) {
    return content;
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return extractTextFromEventContent([content]);
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (block.type === 'thinking' || block.type === 'agent.thinking') continue;
    if (typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
      continue;
    }
    if (block.text && typeof block.text === 'object') {
      const nested = (block.text as Record<string, unknown>).value;
      if (typeof nested === 'string' && nested.length > 0) parts.push(nested);
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
    const fromContent = extractTextFromEventContent(event.content);
    if (fromContent) return fromContent;
    if (typeof event.text === 'string' && event.text.length > 0) return event.text;
    const nested = event.message;
    if (nested && typeof nested === 'object') {
      const fromNested = extractTextFromEventContent((nested as Record<string, unknown>).content);
      if (fromNested) return fromNested;
    }
    return null;
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

/** 是否为用户中止事件（官方 user.interrupt） */
export function isUserInterruptEvent(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'user.interrupt');
}

/** 生成事件去重 key（优先 id） */
export function sessionEventKey(event: { id?: string; type?: string; content?: unknown }): string {
  if (event.id) return event.id;
  return `${event.type ?? 'unknown'}:${JSON.stringify(event.content ?? null)}`;
}

/** 从事件列表末尾倒找最新的会话级 running/idle */
export function latestSessionLifecycle(events: { type?: string }[]): 'running' | 'idle' | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type;
    if (type === 'session.status_idle') return 'idle';
    if (type === 'session.status_running') return 'running';
  }
  return null;
}

export function isToolUseEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const type = (raw as Record<string, unknown>).type;
  return type === 'agent.tool_use' || type === 'agent.mcp_tool_use';
}

export function isToolResultEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const type = (raw as Record<string, unknown>).type;
  return type === 'agent.tool_result' || type === 'agent.mcp_tool_result';
}
