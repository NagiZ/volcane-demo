export type NormalizedSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }
  | {
      type: 'tool';
      tool_name: string;
      call_id: string;
      status: 'running' | 'done' | 'error';
      message?: string;
    };
