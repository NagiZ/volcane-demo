export interface ToolContext {
  /** 与创建 Session 时 USER_ID 一致：tokenHash */
  userId: string;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

export interface CustomToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CustomToolResultItem {
  custom_tool_use_id: string;
  is_error: boolean;
  content: Array<{ type: 'text'; text: string }>;
}
