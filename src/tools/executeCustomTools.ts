import { getToolHandler } from './registry.js';
import type { CustomToolResultItem, CustomToolUse } from './types.js';

export function resultToTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorResult(customToolUseId: string, message: string): CustomToolResultItem {
  return {
    custom_tool_use_id: customToolUseId,
    is_error: true,
    content: [{ type: 'text', text: resultToTextContent({ error: message }) }],
  };
}

export async function executeCustomTools(params: {
  eventIds: string[];
  pending: Map<string, CustomToolUse>;
  userId: string;
}): Promise<CustomToolResultItem[]> {
  const out: CustomToolResultItem[] = [];
  for (const eventId of params.eventIds) {
    const toolEvent = params.pending.get(eventId);
    params.pending.delete(eventId);
    if (!toolEvent) {
      out.push(errorResult(eventId, `Unknown custom_tool_use id: ${eventId}`));
      continue;
    }
    const handler = getToolHandler(toolEvent.name);
    if (!handler) {
      out.push(errorResult(eventId, `Unknown custom tool: ${toolEvent.name}`));
      continue;
    }
    try {
      const result = await handler(toolEvent.input, { userId: params.userId });
      out.push({
        custom_tool_use_id: eventId,
        is_error: false,
        content: [{ type: 'text', text: resultToTextContent(result) }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      console.error(`[custom-tool] ${toolEvent.name} failed:`, message);
      out.push(errorResult(eventId, message));
    }
  }
  return out;
}
