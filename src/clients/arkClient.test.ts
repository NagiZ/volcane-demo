import { describe, expect, it } from 'vitest';
import { buildCreateSessionBody, buildSendSessionEventsBody } from './arkClient.js';

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
