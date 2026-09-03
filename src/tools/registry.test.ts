import { beforeEach, describe, expect, it } from 'vitest';
import { clearToolHandlers, getToolHandler, registerToolHandler } from './registry.js';

describe('tool registry', () => {
  beforeEach(() => clearToolHandlers());

  it('registers and retrieves handler', async () => {
    registerToolHandler('echo', async (input) => input);
    const h = getToolHandler('echo');
    expect(h).toBeTypeOf('function');
    await expect(h!({ a: 1 }, { userId: 'u1' })).resolves.toEqual({ a: 1 });
  });
});
