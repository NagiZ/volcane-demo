import { describe, expect, it, vi } from 'vitest';
import {
  buildCreateSessionBody,
  buildSendInterruptBody,
  buildSendSessionEventsBody,
  buildSessionEventsStreamUrl,
  collectPagedSessionEvents,
} from './arkClient.js';

describe('buildCreateSessionBody', () => {
  it('uses agent and environment.id per Ark API', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      userBearerToken: 'token',
    });

    expect(body.agent).toBe('agent-1');
    expect(body).not.toHaveProperty('agent_id');
    expect(body).not.toHaveProperty('environment_id');

    const environment = body.environment as Record<string, unknown>;
    expect(environment.type).toBe('environment_with_overrides');
    expect(environment.id).toBe('env-1');
    expect(environment).not.toHaveProperty('environment_id');

    const config = environment.config as { env: Record<string, string> };
    expect(config.env.USER_ID).toBe('user-hash');
    expect(config.env.USER_BEARER_TOKEN).toBe('token');
    // 前端输入的 token 需作为 Agent 启动密钥注入
    expect(config.env.LEYO_AGENT_KEY).toBe('token');
  });
});

describe('buildSendSessionEventsBody', () => {
  it('wraps user.message in events array per Ark API', () => {
    const body = buildSendSessionEventsBody('你好');

    expect(body).toEqual({
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: '你好' }],
        },
      ],
    });
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('content');
  });
});

describe('buildSendInterruptBody', () => {
  it('wraps user.interrupt in events array per Ark API', () => {
    expect(buildSendInterruptBody()).toEqual({
      events: [{ type: 'user.interrupt' }],
    });
  });
});

describe('collectPagedSessionEvents', () => {
  it('follows next_page so later agent.message and idle are not dropped', async () => {
    // 复现线上：默认第一页只有历史事件，本轮回复在第二页。
    // 若不跟 next_page，轮询永远看不到 agent.message / session.status_idle，
    // Web 会一直停在「正在输入…」，而方舟控制台已经显示任务完成。
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        events: [
          { id: 'old-1', type: 'session.status_running' },
          { id: 'old-2', type: 'user.message' },
        ],
        nextPage: 'page_2',
      })
      .mockResolvedValueOnce({
        events: [
          {
            id: 'm1',
            type: 'agent.message',
            content: [{ type: 'text', text: '任务已完成' }],
          },
          { id: 'idle', type: 'session.status_idle' },
        ],
        nextPage: null,
      });

    const events = await collectPagedSessionEvents(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'page_2');
    expect(events.map((event) => event.id)).toEqual(['old-1', 'old-2', 'm1', 'idle']);
  });

  it('stops on the first page when next_page is absent', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({
      events: [{ id: 'm1', type: 'agent.message' }],
      nextPage: null,
    });

    const events = await collectPagedSessionEvents(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ id: 'm1', type: 'agent.message' }]);
  });
});

describe('buildSessionEventsStreamUrl', () => {
  it('uses /events/stream per Ark session event stream API', () => {
    expect(buildSessionEventsStreamUrl('https://ark.example/api/v3', 'sesn-1')).toBe(
      'https://ark.example/api/v3/sessions/sesn-1/events/stream',
    );
  });
});
