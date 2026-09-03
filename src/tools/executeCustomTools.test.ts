import { beforeEach, describe, expect, it } from 'vitest';
import { clearToolHandlers, registerToolHandler } from './registry.js';
import { executeCustomTools } from './executeCustomTools.js';
import type { CustomToolUse } from './types.js';

describe('executeCustomTools', () => {
  beforeEach(() => clearToolHandlers());

  it('runs registered tool and serializes JSON text', async () => {
    registerToolHandler('get_user_order', async (input, ctx) => ({
      order_id: input.order_id,
      user_id: ctx.userId,
      status: 'paid',
    }));
    const pending = new Map<string, CustomToolUse>([
      [
        'evt-1',
        { id: 'evt-1', name: 'get_user_order', input: { order_id: 'ORD-1' } },
      ],
    ]);
    const results = await executeCustomTools({
      eventIds: ['evt-1'],
      pending,
      userId: 'hash-u',
    });
    expect(results).toHaveLength(1);
    expect(results[0].custom_tool_use_id).toBe('evt-1');
    expect(results[0].is_error).toBe(false);
    expect(JSON.parse(results[0].content[0].text)).toMatchObject({
      order_id: 'ORD-1',
      user_id: 'hash-u',
      status: 'paid',
    });
  });

  it('returns is_error for unknown tool and missing pending', async () => {
    const pending = new Map<string, CustomToolUse>();
    const results = await executeCustomTools({
      eventIds: ['missing', 'evt-2'],
      pending: new Map([
        ['evt-2', { id: 'evt-2', name: 'nope', input: {} }],
      ]),
      userId: 'u',
    });
    expect(results[0].is_error).toBe(true);
    expect(results[1].is_error).toBe(true);
  });
});
