import type { ToolCallStatus } from '../types';

function statusLabel(item: ToolCallStatus): string {
  if (item.status === 'running') return '调用中';
  if (item.status === 'done') return '完成';
  return item.message ? `失败：${item.message}` : '失败';
}

export function ToolStatusBar({ items }: { items: ToolCallStatus[] }) {
  if (items.length === 0) return null;
  return (
    <div className="tool-status" aria-live="polite">
      <div className="tool-status__title">自定义工具</div>
      <ul className="tool-status__list">
        {items.map((item) => (
          <li
            key={item.call_id}
            className={`tool-status__item tool-status__item--${item.status}`}
          >
            <span className="tool-status__name">{item.tool_name}</span>
            <span className="tool-status__state">{statusLabel(item)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
