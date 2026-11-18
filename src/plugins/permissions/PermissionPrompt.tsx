// 权限授权 Modal(M-Plugin v3.4)。
// 订阅 promptStore,无 pending 时不渲染。

import { useCallback, useMemo, useState } from 'react';
import { Button, Modal } from '@/design';
import { usePermissionPromptStore } from './promptStore';
import type { FsScopePrompt, Pending } from './promptStore';
import type { PermissionKey } from '../permissions';
import { useT } from '@/i18n';
import { PermissionOptionRow } from './PermissionOptionRow';
import {
  PROMPT_GRANT_BUTTON_PROPS,
  usePromptGrantGuard,
  type PromptGrantGuard,
} from '@/lib/use-prompt-grant-guard';

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
 * 安全:默认不预选的权限,须用户主动勾选(或点「全选」)才会授予。`shell` 等同于完全访问本机(以用户身份运行任意
 * 程序,不受文件夹授权限制),不能随一次「授权选中」顺手给出;其余权限照旧默认预选。
 */
const NOT_PRESELECTED: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['shell']);

function defaultSelected(perms: readonly PermissionKey[]): Set<PermissionKey> {
  const selected = new Set<PermissionKey>();
  for (const perm of perms) if (!NOT_PRESELECTED.has(perm)) selected.add(perm);
  return selected;
}

// 每个 manifest 请求一个 body 实例(pending 无自带 id,按对象身份编号):排队 A→B 时勾选与初始焦点都重新来过。
const manifestKeys = new WeakMap<Pending, number>();
let nextManifestKey = 0;
function manifestKey(pending: Pending): number {
  let key = manifestKeys.get(pending);
  if (key === undefined) {
    key = nextManifestKey++;
    manifestKeys.set(pending, key);
  }
  return key;
}

/**
 * 轻量 shell(打磨 R52,仿 R32/R50):权限弹窗绝大多数时间为空闲态。外层只订阅
 * pending / currentFsScope 两个队列字段,都空时直接返回 null。manifest 弹窗与
 * fs-scope 弹窗各自拆成 body 子组件,仅在对应请求存在时挂载 —— 空闲态不再 useT、
 * 不订阅 grant/deny actions、不初始化 selected state。manifest 优先。
 *
 * 防误触(守卫放在 shell 里,body 换类型 / remount 不丢状态;实现见 lib/use-prompt-grant-guard):
 * - 授予方向(canGrant):键盘激活须是停顿后的有意按键;此外请求出现后短时间内无效 —— 首次出现(时机由插件决定:启用时的 manifest 权限、运行时的
 *   requestScope)与切换(同类排队 A→B、fs-scope↔manifest 类型切换)都算。
 * - 拒绝方向(switchSettled):首次出现立即可用;只在直接切换后短时间内无效(新弹窗按钮与旧弹窗在同一位置,对旧
 *   弹窗连点 / Esc 键重复的第二下不能把新请求拒掉 —— manifest 的拒绝会写盘)。
 * 初始焦点在拒绝按钮上。
 */
export function PermissionPrompt() {
  const pending = usePermissionPromptStore((s) => s.pending);
  const currentFsScope = usePermissionPromptStore((s) => s.currentFsScope);
  const guard = usePromptGrantGuard(pending ?? currentFsScope);
  if (pending) return <ManifestPromptBody key={manifestKey(pending)} pending={pending} guard={guard} />;
  if (currentFsScope) {
    return <FsScopePromptBody key={currentFsScope.requestId} scope={currentFsScope} guard={guard} />;
  }
  return null;
}

function ManifestPromptBody({ pending, guard }: { pending: Pending; guard: PromptGrantGuard }) {
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
  // 以请求身份为 key 挂载(shell 端):换请求即 remount,勾选回到新请求的默认值(shell 不预选)。
  const [selected, setSelected] = useState<Set<PermissionKey>>(() =>
    defaultSelected(pending.perms),
  );
  // 引用必须稳定:Modal 的焦点 / 键盘 effect 依赖 onClose,每次渲染换新引用会让它反复重跑
  //(勾选一次,焦点就先被还给弹窗外、再跳回弹窗内第一个元素)。guard 引用稳定。
  const handleClose = useCallback(() => {
    if (guard.switchSettled()) denyAll();
  }, [guard, denyAll]);

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
      // Esc(键重复)/ 点遮罩也是「全部拒绝」入口,与拒绝按钮同一守卫(只在切换后短时间内无效)。
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
            // 初始焦点放在拒绝方向(Modal 默认聚焦第一个可聚焦元素 = 第一个勾选框)。
            data-autofocus
            onClick={handleClose}
          >
            {t('permissions.prompt.deny_all')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            {...PROMPT_GRANT_BUTTON_PROPS}
            onClick={(e) => {
              if (guard.canGrant(e)) grant(copySelectedPermissions(selected));
            }}
          >
            {t('permissions.prompt.grant_selected', { count: selected.size })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// 以 requestId 为 key 挂载(shell 端):换请求即 remount。
function FsScopePromptBody({ scope, guard }: { scope: FsScopePrompt; guard: PromptGrantGuard }) {
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
  const { requestId } = scope;
  // Esc(键重复)/ 点遮罩也是拒绝入口,与拒绝按钮同一守卫(只在切换后短时间内无效);引用稳定(同 manifest 分支)。
  const handleClose = useCallback(() => {
    if (guard.switchSettled()) denyFsScope(requestId);
  }, [guard, denyFsScope, requestId]);
  return (
    <Modal
      visible
      onClose={handleClose}
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
          // 初始焦点在拒绝方向。
          data-autofocus
          onClick={handleClose}
        >
          {t('permissions.fs_scope.deny')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          {...PROMPT_GRANT_BUTTON_PROPS}
          onClick={(e) => {
            if (guard.canGrant(e)) grantFsScope(requestId);
          }}
        >
          {t('permissions.fs_scope.grant')}
        </Button>
      </div>
    </Modal>
  );
}
