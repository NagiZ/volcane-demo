import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArkApiError,
  buildCreateSessionBody,
  buildCustomToolResultEvents,
  buildMountFileBody,
  buildSendInterruptBody,
  buildSendSessionEventsBody,
  buildSessionEventsStreamUrl,
  collectPagedSessionEvents,
  sendCustomToolResults,
} from './arkClient.js';

describe('buildCreateSessionBody', () => {
  it('uses agent and environment.id per Ark API', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      vaultIds: ['vault-1'],
    });

    expect(body.agent).toBe('agent-1');
    expect(body).not.toHaveProperty('agent_id');
    expect(body).not.toHaveProperty('environment_id');

    const environment = body.environment as Record<string, unknown>;
    expect(environment.type).toBe('environment_with_overrides');
    expect(environment.id).toBe('env-1');
    expect(environment).not.toHaveProperty('environment_id');

    const config = environment.config as {
      env: Record<string, string>;
      vault_ids: string[];
    };
    expect(config.env).toEqual({ USER_ID: 'user-hash' });
    expect(config.env).not.toHaveProperty('USER_BEARER_TOKEN');
    expect(config.env).not.toHaveProperty('LEYO_AGENT_KEY');
    expect(config.vault_ids).toEqual(['vault-1']);
  });

  it('includes memory_store resources when provided', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      vaultIds: ['vault-1'],
      resources: [
        {
          type: 'memory_store',
          memory_store_id: 'memstore-1',
          instructions: 'read user_profile.json',
        },
      ],
    });
    expect(body.resources).toEqual([
      {
        type: 'memory_store',
        memory_store_id: 'memstore-1',
        instructions: 'read user_profile.json',
      },
    ]);
  });

  it('omits resources when not provided', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      vaultIds: ['vault-1'],
    });
    expect(body).not.toHaveProperty('resources');
  });
});

describe('buildSendSessionEventsBody', () => {
  it('wraps user.message in events array per Ark API', () => {
    const body = buildSendSessionEventsBody({ userMessage: '你好' });

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

describe('buildSendSessionEventsBody with files', () => {
  it('appends mount path hint and file blocks', () => {
    const body = buildSendSessionEventsBody({
      userMessage: '分析',
      mountedPaths: ['/mnt/session/uploads/a.pdf'],
      inlineFileIds: ['file-1'],
    });
    const event = body.events[0];
    expect(event.type).toBe('user.message');
    const content = (event as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'text', text: '分析' });
    expect(content[1]).toMatchObject({ type: 'text' });
    expect(String((content[1] as { text: string }).text)).toContain('/mnt/session/uploads/a.pdf');
    expect(content[2]).toEqual({ type: 'file', file_id: 'file-1' });
  });
});

describe('buildMountFileBody', () => {
  it('matches Ark session resources shape', () => {
    expect(buildMountFileBody('file-1', '/a.pdf')).toEqual({
      type: 'file',
      file_id: 'file-1',
      mount_path: '/a.pdf',
    });
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

describe('buildCustomToolResultEvents', () => {
  it('matches official user.custom_tool_result shape', () => {
    expect(
      buildCustomToolResultEvents([
        {
          custom_tool_use_id: 'evt-1',
          is_error: false,
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      ]),
    ).toEqual({
      events: [
        {
          type: 'user.custom_tool_result',
          custom_tool_use_id: 'evt-1',
          is_error: false,
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      ],
    });
  });
});

describe('sendCustomToolResults', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no-ops when results is empty', async () => {
    const post = vi.spyOn(axios, 'post');
    await sendCustomToolResults({
      arkApiKey: 'k',
      arkBaseUrl: 'https://ark.example/api/v3',
      sessionId: 'sesn-1',
      results: [],
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('posts custom_tool_result events to /sessions/{id}/events', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: {} });
    await sendCustomToolResults({
      arkApiKey: 'k',
      arkBaseUrl: 'https://ark.example/api/v3',
      sessionId: 'sesn-1',
      results: [
        {
          custom_tool_use_id: 'evt-1',
          is_error: false,
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      ],
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'https://ark.example/api/v3/sessions/sesn-1/events',
      {
        events: [
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: 'evt-1',
            is_error: false,
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
        ],
      },
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer k',
          'Content-Type': 'application/json',
        },
        timeout: 0,
      }),
    );
  });

  it('retries failed posts up to 3 attempts by default then throws ArkApiError', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockRejectedValue(new Error('network down'));
    await expect(
      sendCustomToolResults({
        arkApiKey: 'k',
        arkBaseUrl: 'https://ark.example/api/v3',
        sessionId: 'sesn-1',
        results: [
          {
            custom_tool_use_id: 'evt-1',
            is_error: true,
            content: [{ type: 'text', text: 'err' }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ArkApiError);
    expect(post).toHaveBeenCalledTimes(3);
  });
});
