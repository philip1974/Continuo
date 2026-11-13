// 权限授权 Modal(M-Plugin v3.4)。
// 订阅 promptStore,无 pending 时不渲染。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal } from '@/design';
import { usePermissionPromptStore } from './promptStore';
import type { FsScopePrompt, Pending } from './promptStore';
import type { PermissionKey } from '../permissions';
import { useT } from '@/i18n';
import { PermissionOptionRow } from './PermissionOptionRow';

const PLUGIN_ID_MARKER = ' __PID__ ';
const EMPTY_SELECTED_PERMISSIONS: PermissionKey[] = [];

function splitPluginIdTemplate(tpl: string): {
  readonly prefix: string;
  readonly suffix: string;
} {
  const markerStart = tpl.indexOf(PLUGIN_ID_MARKER);
  if (markerStart < 0) return { prefix: tpl, suffix: '' };
  const suffixStart = markerStart + PLUGIN_ID_MARKER.length;
  const nextMarker = tpl.indexOf(PLUGIN_ID_MARKER, suffixStart);
  return {
    prefix: tpl.slice(0, markerStart),
    suffix: tpl.slice(suffixStart, nextMarker < 0 ? tpl.length : nextMarker),
  };
}

export function copySelectedPermissions(
  selected: ReadonlySet<PermissionKey>,
): PermissionKey[] {
  if (selected.size === 0) return EMPTY_SELECTED_PERMISSIONS;
  const out = new Array<PermissionKey>(selected.size);
  let i = 0;
  for (const perm of selected) out[i++] = perm;
  return out;
}

/**
 * 轻量 shell(打磨 R52,仿 R32/R50):权限弹窗绝大多数时间为空闲态。外层只订阅
 * pending / currentFsScope 两个队列字段,都空时直接返回 null。manifest 弹窗与
 * fs-scope 弹窗各自拆成 body 子组件,仅在对应请求存在时挂载 —— 空闲态不再 useT、
 * 不订阅 grant/deny actions、不初始化 selected state/effect。manifest 优先。
 */
/** 排队切换到下一个请求后,忽略「授予 / 全部拒绝」点击的时长(覆盖一次双击的间隔)。 */
const HANDOVER_GUARD_MS = 500;

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
  const promptBodyTemplate = t('permissions.prompt.body', {
    pluginId: PLUGIN_ID_MARKER,
  });
  const promptBodyParts = useMemo(
    () => splitPluginIdTemplate(promptBodyTemplate),
    [promptBodyTemplate],
  );
  // body 仅在某次 pending 存在时挂载;同一身份的请求保持勾选,默认全选。
  // 用 pending.pluginId+perms 作 key 在 shell 端 remount 即可重置,这里直接初值全选。
  const [selected, setSelected] = useState<Set<PermissionKey>>(
    () => new Set(pending.perms),
  );
  // pending 直接 A→B 覆盖(排队的下一个请求;不经 null,body 不 remount)时也重置勾选为新请求的默认全选,
  // 并记下切换时刻:B 的按钮与 A 的在同一位置且默认全选,对 A 连点的第二下不能落到 B 上。
  const firstPendingRef = useRef(pending);
  const handoverAtRef = useRef<number | null>(null);
  useEffect(() => {
    setSelected(new Set(pending.perms));
    if (pending !== firstPendingRef.current) handoverAtRef.current = Date.now();
  }, [pending]);
  const decisionArmed = (): boolean =>
    handoverAtRef.current === null || Date.now() - handoverAtRef.current >= HANDOVER_GUARD_MS;
  // 引用必须稳定:Modal 的焦点 / 键盘 effect 依赖 onClose,每次渲染换新引用会让它反复重跑
  //(勾选一次,焦点就先被还给弹窗外、再跳回弹窗内第一个元素)。只读 ref,无需其它依赖。
  const handleClose = useCallback(() => {
    const at = handoverAtRef.current;
    if (at === null || Date.now() - at >= HANDOVER_GUARD_MS) denyAll();
  }, [denyAll]);

  const toggle = (perm: PermissionKey) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  };

  return (
    <Modal
      visible
      // Esc(键重复)/ 点遮罩也是「全部拒绝」入口,同样受切换守卫约束。
      onClose={handleClose}
      aria-labelledby="permission-prompt-title"
    >
      {/* a11y(A13):dialog(A10)须经 aria-labelledby 关联标题,否则 AT 只听到无名 dialog。 */}
      <h2 id="permission-prompt-title" className="mb-1 text-sm font-medium text-fg">
        {t('permissions.prompt.title')}
      </h2>
      <p className="mb-2 text-xs text-fg-muted">
        {/* tpl 含 {pluginId}；inline <code> 渲染 — 拆 prefix/suffix */}
        {promptBodyParts.prefix}
        <code className="text-fg">{pending.pluginId}</code>
        {promptBodyParts.suffix}
      </p>
      <p className="mb-3 text-2xs text-fg-dim">
        {t('permissions.prompt.note_prefix')}
        <span className="text-fg">{t('permissions.prompt.note_partial')}</span>
        {t('permissions.prompt.note_suffix')}
      </p>
      <ul className="mb-4 space-y-1">
        {pending.perms.map((perm) => (
          <PermissionOptionRow
            key={perm}
            perm={perm}
            checked={selected.has(perm)}
            onToggle={toggle}
          />
        ))}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (decisionArmed()) denyAll();
            }}
          >
            {t('permissions.prompt.deny_all')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (decisionArmed()) grant(copySelectedPermissions(selected));
            }}
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
  const fsScopeBodyTemplate = t('permissions.fs_scope.body', {
    pluginId: PLUGIN_ID_MARKER,
  });
  const fsScopeBodyParts = useMemo(
    () => splitPluginIdTemplate(fsScopeBodyTemplate),
    [fsScopeBodyTemplate],
  );
  return (
    <Modal
      visible
      onClose={() => denyFsScope(scope.requestId)}
      aria-labelledby="permission-fs-scope-title"
    >
      {/* a11y(A13):同上,fs-scope 弹窗关联标题。 */}
      <h2 id="permission-fs-scope-title" className="mb-1 text-sm font-medium text-fg">
        {t('permissions.fs_scope.title')}
      </h2>
      <p className="mb-3 text-xs text-fg-muted">
        {/* tpl 含 {pluginId};inline <code> 渲染 — 拆 prefix/suffix(同 manifest 分支) */}
        {fsScopeBodyParts.prefix}
        <code className="text-fg">{scope.pluginId}</code>
        {fsScopeBodyParts.suffix}
      </p>
      <ul className="mb-4 space-y-1 text-xs">
        {scope.scopes.map((s, i) => (
          <li
            key={`${s.path}:${i}`}
            className="rounded border border-line bg-panel-soft p-2"
          >
            <div className="font-mono text-fg">
              {s.displayPath}
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
