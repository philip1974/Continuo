// 权限授权 Modal(M-Plugin v3.4)。
// 订阅 promptStore,无 pending 时不渲染。

import { useEffect, useState } from 'react';
import { Button, Modal } from '@/design';
import { usePermissionPromptStore } from './promptStore';
import type { PermissionKey } from '../permissions';

const PERMISSION_LABELS: Record<PermissionKey, { title: string; desc: string }> = {
  fs: { title: '文件系统', desc: '读写本地文件夹与文件' },
  network: { title: '网络访问', desc: '发起 HTTP / WebSocket 等远程请求' },
  shell: { title: '执行 shell 命令', desc: '调用本机 shell / 子进程' },
  clipboard: { title: '剪贴板', desc: '读写系统剪贴板' },
  'mcp-tools': {
    title: '注册 MCP 工具',
    desc: '把 plugin 自定义工具暴露给 Agent / Claude Code 等 MCP client 调用',
  },
};

export function PermissionPrompt() {
  const pending = usePermissionPromptStore((s) => s.pending);
  const grant = usePermissionPromptStore((s) => s.grant);
  const denyAll = usePermissionPromptStore((s) => s.denyAll);

  // 每次 pending 变化时重置勾选(默认全选)
  const [selected, setSelected] = useState<Set<PermissionKey>>(new Set());
  useEffect(() => {
    if (pending) setSelected(new Set(pending.perms));
    else setSelected(new Set());
  }, [pending]);

  if (!pending) return null;

  const toggle = (perm: PermissionKey) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  };

  return (
    <Modal visible onClose={denyAll}>
      <h2 className="mb-1 text-sm font-medium text-fg">权限请求</h2>
      <p className="mb-2 text-xs text-fg-muted">
        插件 <code className="text-fg">{pending.pluginId}</code> 请求以下权限:
      </p>
      <p className="mb-3 text-2xs text-fg-dim">
        未勾视为拒绝。支持<span className="text-fg">部分授权</span>:
        plugin 调未授 API 时会被拒(抛 PermissionError),整体仍能激活。
        全部拒绝则 plugin 不激活。
      </p>
      <ul className="mb-4 space-y-1">
        {pending.perms.map((perm) => {
          const meta = PERMISSION_LABELS[perm];
          const checked = selected.has(perm);
          return (
            <li key={perm}>
              <label className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-hover">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(perm)}
                  className="mt-0.5 accent-accent"
                />
                <div className="flex-1 text-xs">
                  <div className="font-medium text-fg">{meta.title}</div>
                  <div className="text-fg-dim">{meta.desc}</div>
                </div>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelected(new Set(pending.perms))}
        >
          全选
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={denyAll}>
            全部拒绝
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => grant(Array.from(selected))}
          >
            授权选中({selected.size})
          </Button>
        </div>
      </div>
    </Modal>
  );
}
