/**
 * 从方舟 Session 事件 JSON 中提取可展示文本增量。
 * 只映射用户可见文本；工具/中间状态事件返回 null。
 */
export function extractTextDeltaFromArkEvent(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;

  // 常见增量字段（按官方文档校准）
  if (typeof event.delta === 'string' && event.delta.length > 0) {
    return event.delta;
  }
  if (typeof event.text === 'string' && event.text.length > 0) {
    return event.text;
  }

  const content = event.content;
  if (typeof content === 'string' && content.length > 0) {
    return content;
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part as Record<string, unknown>).type === 'output_text' &&
        typeof (part as Record<string, unknown>).text === 'string',
    ) as Record<string, unknown> | undefined;
    if (textPart?.text) return String(textPart.text);
  }

  return null;
}
