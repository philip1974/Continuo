// 权限编辑 Modal(M-Plugin v4.7)。
//
// 让用户事后改主意:展示插件 manifest 声明的所有权限,checkbox 表示
// granted/denied(prior decision 来自 PermissionStore),保存只写 store +
// 提示"下次启用生效"。当前 enabled 实例不会被强制 disable(避免插件
// 状态丢失);用户要立即生效手动 [禁用] → [启用]。

import { useEffect, useState } from 'react';
import { Button, Modal } from '@/design';
import type { PermissionKey, PermissionStore } from '../permissions';
import { useT } from '@/i18n';
import { PERM_LABEL_KEYS } from './perm-labels';

interface PermissionEditorModalProps {
  open: boolean;
  pluginId: string | null;
  declared: readonly PermissionKey[];
  store: PermissionStore;
  onClose: () => void;
}

export function PermissionEditorModal({
  open,
  pluginId,
  declared,
  store,
  onClose,
}: PermissionEditorModalProps) {
  const t = useT();
  // null = 未决, true = granted, false = denied
  const [decisions, setDecisions] = useState<Map<PermissionKey, boolean | null>>(
    new Map(),
  );

  useEffect(() => {
    if (!open || !pluginId) return;
    let cancelled = false;
    void store.get(pluginId).then((list) => {
      if (cancelled) return;
      const m = new Map<PermissionKey, boolean | null>();
      for (const p of declared) m.set(p, null);
      for (const d of list) m.set(d.permission, d.granted);
      setDecisions(m);
    });
    return () => {
      cancelled = true;
    };
  }, [open, pluginId, declared, store]);

  if (!pluginId) return null;

  const toggle = (perm: PermissionKey) => {
    setDecisions((m) => {
      const next = new Map(m);
      // null/false → true (granted),true → false (denied)
      next.set(perm, next.get(perm) === true ? false : true);
      return next;
    });
  };

  const save = async () => {
    const toGrant: PermissionKey[] = [];
    const toDeny: PermissionKey[] = [];
    for (const [perm, granted] of decisions) {
      if (granted === true) toGrant.push(perm);
      else if (granted === false) toDeny.push(perm);
    }
    if (toGrant.length > 0) await store.grant(pluginId, toGrant);
    if (toDeny.length > 0) await store.deny(pluginId, toDeny);
    onClose();
  };

  return (
    <Modal visible={open} onClose={onClose}>
      <h2 className="mb-1 text-sm font-medium text-fg">
        {t('permissions.editor.title')}
      </h2>
      <p className="mb-3 text-xs text-fg-muted">
        {t('permissions.editor.plugin_id_label')}{' '}
        <code className="text-fg">{pluginId}</code>
      </p>
      <ul className="mb-3 space-y-1">
        {declared.map((perm) => {
          const meta = PERM_LABEL_KEYS[perm];
          const state = decisions.get(perm);
          const checked = state === true;
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
      <div className="mb-4 rounded border border-line bg-panel-soft/40 px-3 py-2 text-xs text-fg-muted">
        {t('permissions.editor.next_enable_note_prefix')}
        <span className="text-fg">{t('permissions.editor.next_enable_emphasis')}</span>
        {t('permissions.editor.next_enable_note_suffix')}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('permissions.editor.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={save}>
          {t('permissions.editor.save')}
        </Button>
      </div>
    </Modal>
  );
}
