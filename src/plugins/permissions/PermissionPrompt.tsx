// 权限授权 Modal(M-Plugin v3.4)。
// 订阅 promptStore,无 pending 时不渲染。

import { useEffect, useState } from 'react';
import { Button, Modal } from '@/design';
import { usePermissionPromptStore } from './promptStore';
import type { PermissionKey } from '../permissions';
import { useT } from '@/i18n';
import { PERM_LABEL_KEYS } from './perm-labels';

export function PermissionPrompt() {
  const t = useT();
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
