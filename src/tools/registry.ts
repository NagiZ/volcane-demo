import type { ToolHandler } from './types.js';

const handlers = new Map<string, ToolHandler>();

export function registerToolHandler(name: string, handler: ToolHandler): void {
  const key = name.trim();
  if (!key) throw new Error('tool name is required');
  handlers.set(key, handler);
}

export function getToolHandler(name: string): ToolHandler | undefined {
  return handlers.get(name);
}

/** 仅供单测重置 */
export function clearToolHandlers(): void {
  handlers.clear();
}
