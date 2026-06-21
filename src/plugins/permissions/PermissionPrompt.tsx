// 权限授权 Modal(M-Plugin v3.4)。
// 订阅 promptStore,无 pending 时不渲染。

import { useEffect, useState } from 'react';
import { Button, Modal } from '@/design';
import { usePermissionPromptStore } from './promptStore';
import type { FsScopePrompt, Pending } from './promptStore';
import type { PermissionKey } from '../permissions';
import { useT } from '@/i18n';
import { PERM_LABEL_KEYS } from './perm-labels';

/**
 * 轻量 shell(打磨 R52,仿 R32/R50):权限弹窗绝大多数时间为空闲态。外层只订阅
 * pending / currentFsScope 两个队列字段,都空时直接返回 null。manifest 弹窗与
 * fs-scope 弹窗各自拆成 body 子组件,仅在对应请求存在时挂载 —— 空闲态不再 useT、
 * 不订阅 grant/deny actions、不初始化 selected state/effect。manifest 优先。
 */
export function PermissionPrompt() {
  const pending = usePermissionPromptStore((s) => s.pending);
  const currentFsScope = usePermissionPromptStore((s) => s.currentFsScope);
  if (pending) return <ManifestPromptBody pending={pending} />;
  if (currentFsScope) return <FsScopePromptBody scope={currentFsScope} />;
  return null;
}

function ManifestPromptBody({ pending }: { pending: Pending }) {
  const t = useT();
  const grant = usePermissionPromptStore((s) => s.grant);
  const denyAll = usePermissionPromptStore((s) => s.denyAll);
  // body 仅在某次 pending 存在时挂载;同一身份的请求保持勾选,默认全选。
  // 用 pending.pluginId+perms 作 key 在 shell 端 remount 即可重置,这里直接初值全选。
  const [selected, setSelected] = useState<Set<PermissionKey>>(
    () => new Set(pending.perms),
  );
  // pending 直接 A→B 覆盖(不经 null,body 不 remount)时也重置勾选为新请求的默认全选。
  useEffect(() => {
    setSelected(new Set(pending.perms));
  }, [pending]);

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
      <h2 className="mb-1 text-sm font-medium text-fg">
        {t('permissions.prompt.title')}
      </h2>
      <p className="mb-2 text-xs text-fg-muted">
        {/* tpl 含 {pluginId}；inline <code> 渲染 — 拆 prefix/suffix */}
        {(() => {
          const tpl = t('permissions.prompt.body', { pluginId: ' __PID__ ' });
          const parts = tpl.split(' __PID__ ');
          return (
            <>
              {parts[0]}
              <code className="text-fg">{pending.pluginId}</code>
              {parts[1] ?? ''}
            </>
          );
        })()}
      </p>
      <p className="mb-3 text-2xs text-fg-dim">
        {t('permissions.prompt.note_prefix')}
        <span className="text-fg">{t('permissions.prompt.note_partial')}</span>
        {t('permissions.prompt.note_suffix')}
      </p>
      <ul className="mb-4 space-y-1">
        {pending.perms.map((perm) => {
          const meta = PERM_LABEL_KEYS[perm];
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
                  <div className="font-medium text-fg">{t(meta.titleKey)}</div>
                  <div className="text-fg-dim">{t(meta.descKey)}</div>
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
          {t('permissions.prompt.select_all')}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={denyAll}>
            {t('permissions.prompt.deny_all')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => grant(Array.from(selected))}
          >
            {t('permissions.prompt.grant_selected', { count: selected.size })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FsScopePromptBody({ scope }: { scope: FsScopePrompt }) {
  const t = useT();
  const grantFsScope = usePermissionPromptStore((s) => s.grantFsScope);
  const denyFsScope = usePermissionPromptStore((s) => s.denyFsScope);
  return (
    <Modal visible onClose={() => denyFsScope(scope.requestId)}>
      <h2 className="mb-1 text-sm font-medium text-fg">
        {t('permissions.fs_scope.title')}
      </h2>
      <p className="mb-3 text-xs text-fg-muted">
        {/* tpl 含 {pluginId};inline <code> 渲染 — 拆 prefix/suffix(同 manifest 分支) */}
        {(() => {
          const tpl = t('permissions.fs_scope.body', { pluginId: ' __PID__ ' });
          const parts = tpl.split(' __PID__ ');
          return (
            <>
              {parts[0]}
              <code className="text-fg">{scope.pluginId}</code>
              {parts[1] ?? ''}
            </>
          );
        })()}
      </p>
      <ul className="mb-4 space-y-1 text-xs">
        {scope.scopes.map((s, i) => (
          <li
            key={`${s.path}:${i}`}
            className="rounded border border-line bg-panel-soft p-2"
          >
            <div className="font-mono text-fg">
              {(s as { displayPath?: string }).displayPath ?? s.path}
            </div>
            <div className="text-fg-dim">
              {t('permissions.fs_scope.mode_label')}:{' '}
              {s.mode === 'rw'
                ? t('permissions.fs_scope.mode_rw')
                : t('permissions.fs_scope.mode_ro')}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => denyFsScope(scope.requestId)}
        >
          {t('permissions.fs_scope.deny')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => grantFsScope(scope.requestId)}
        >
          {t('permissions.fs_scope.grant')}
        </Button>
      </div>
    </Modal>
  );
}
