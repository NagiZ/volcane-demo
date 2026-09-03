import { registerToolHandler } from './registry.js';

export function registerBuiltinTools(): void {
  registerToolHandler('get_user_order', async (input, ctx) => {
    const orderId = typeof input.order_id === 'string' ? input.order_id : 'unknown';
    return {
      order_id: orderId,
      user_id: ctx.userId,
      status: 'paid',
      amount: 99.0,
      currency: 'CNY',
    };
  });

  registerToolHandler('create_work_order', async (input, ctx) => {
    const title = typeof input.title === 'string' ? input.title : '';
    const content = typeof input.content === 'string' ? input.content : '';
    return {
      work_order_id: `WO-${Date.now()}`,
      title,
      content,
      status: 'created',
      created_by: ctx.userId,
    };
  });
}
