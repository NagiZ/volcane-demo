import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchHealth, interruptSession, rebuildSession, streamChat } from './api';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { TokenBar } from './components/TokenBar';
import type { BackendStatus, ChatMessage } from './types';

const TOKEN_STORAGE_KEY = 'volcane.webUserToken';
const DEFAULT_TOKEN = 'demo-user';
const HEALTH_POLL_MS = 12_000;

function nextId(): string {
  return crypto.randomUUID();
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError';
}

function readStoredToken(): string {
  const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (stored && stored.length > 0) return stored;
  localStorage.setItem(TOKEN_STORAGE_KEY, DEFAULT_TOKEN);
  return DEFAULT_TOKEN;
}

export function App() {
  const [token, setToken] = useState(readStoredToken);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [waitingDelta, setWaitingDelta] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking');
  const [notice, setNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);

  const busy = streaming || rebuilding;

  const abortInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setWaitingDelta(false);
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function ping() {
      try {
        const ok = await fetchHealth(controller.signal);
        if (!cancelled) setBackendStatus(ok ? 'online' : 'offline');
      } catch {
        if (!cancelled && !controller.signal.aborted) setBackendStatus('offline');
      }
    }

    void ping();
    const timer = window.setInterval(() => {
      void ping();
    }, HEALTH_POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  function handleTokenChange(value: string) {
    if (value === token) return;
    if (streaming) {
      void interruptSession(token.trim()).catch(() => {
        // 换 token 时尽力停下旧 Session，失败不阻塞切换
      });
    }
    abortInFlight();
    setToken(value);
    localStorage.setItem(TOKEN_STORAGE_KEY, value);
    setMessages([]);
    setNotice(null);
  }

  async function handleRebuild() {
    const trimmed = token.trim();
    if (busy || trimmed.length === 0) return;
    abortInFlight();
    setRebuilding(true);
    setNotice(null);
    try {
      const result = await rebuildSession(trimmed);
      setMessages([]);
      setNotice(`会话已重建 · ${result.sessionId}`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '重建会话失败，请确认后端是否在线';
      setNotice(message);
    } finally {
      setRebuilding(false);
    }
  }

  async function handleSend(userMessage: string) {
    if (busy) return;
    const trimmedToken = token.trim();
    if (trimmedToken.length === 0) {
      setNotice('webUserToken 不能为空');
      return;
    }

    const user: ChatMessage = { id: nextId(), role: 'user', content: userMessage };
    const agentId = nextId();
    let gotDelta = false;
    let gotError = false;
    interruptedRef.current = false;

    setMessages((prev) => [...prev, user]);
    setNotice(null);
    setStreaming(true);
    setWaitingDelta(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat({
        webUserToken: trimmedToken,
        userMessage,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'delta') {
            gotDelta = true;
            setWaitingDelta(false);
            setMessages((prev) => {
              const existing = prev.find((item) => item.id === agentId);
              if (!existing) {
                return [...prev, { id: agentId, role: 'agent', content: event.text }];
              }
              return prev.map((item) =>
                item.id === agentId ? { ...item, content: item.content + event.text } : item,
              );
            });
            return;
          }

          if (event.type === 'done') {
            setWaitingDelta(false);
            return;
          }

          if (event.type === 'error') {
            if (event.code === 'ABORTED' || controller.signal.aborted) return;
            gotError = true;
            setWaitingDelta(false);
            setMessages((prev) => [
              ...prev.filter((item) => item.id !== agentId || item.content.length > 0),
              {
                id: nextId(),
                role: 'error',
                code: event.code,
                content: event.message,
              },
            ]);
          }
        },
      });

      if (interruptedRef.current) {
        setNotice('已中止当次对话');
        interruptedRef.current = false;
      } else if (!controller.signal.aborted && !gotDelta && !gotError) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'error',
            code: 'EMPTY_STREAM',
            content: '未收到 Agent 回复，请稍后重试',
          },
        ]);
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : '网络异常，无法连接后端';
      setWaitingDelta(false);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'error',
          code: err instanceof ApiError ? `HTTP_${err.status}` : 'NETWORK',
          content: message,
        },
      ]);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(false);
        setWaitingDelta(false);
      }
    }
  }

  async function handleAbort() {
    if (!streaming || interrupting) return;
    const trimmed = token.trim();
    if (trimmed.length === 0) return;
    setInterrupting(true);
    interruptedRef.current = true;
    setNotice(null);
    try {
      await interruptSession(trimmed);
      setNotice('已发送中止，等待 Agent 停下…');
    } catch (err) {
      interruptedRef.current = false;
      const message = err instanceof ApiError ? err.message : '中止失败，请确认后端是否在线';
      setNotice(message);
    } finally {
      setInterrupting(false);
    }
  }

  return (
    <div className="shell">
      <TokenBar
        token={token}
        backendStatus={backendStatus}
        rebuilding={rebuilding}
        busy={streaming}
        notice={notice}
        onTokenChange={handleTokenChange}
        onRebuild={() => {
          void handleRebuild();
        }}
      />
      <main className="stage">
        <MessageList messages={messages} waiting={waitingDelta} />
      </main>
      <Composer
        disabled={busy}
        streaming={streaming}
        interrupting={interrupting}
        onSend={(text) => void handleSend(text)}
        onAbort={() => {
          void handleAbort();
        }}
      />
    </div>
  );
}
