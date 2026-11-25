// 权限编辑 Modal(M-Plugin v4.7)。
//
// 让用户事后改主意:展示插件 manifest 声明的所有权限,checkbox 表示
// granted/denied(prior decision 来自 PermissionStore),保存只写 store。当前 enabled 实例不会被强制 disable
// (避免插件状态丢失):撤销即时生效(各能力调用时现读 store,MCP 工具随 recheck 注销);只有重新授予
// MCP 工具权限需用户 [禁用] → [启用] 让插件重新注册工具(提示文案同此)。

import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@/design';
import type {
  PermissionDecision,
  PermissionKey,
  PermissionStore,
} from '../permissions';
import { useT } from '@/i18n';
import { PermissionOptionRow } from './PermissionOptionRow';
import { useStableCallback } from '@/lib/use-stable-callback';
import { usePluginDisplayName } from '../use-user-plugin-list';
import { UntrustedText } from '@/lib/untrusted-text';

interface PermissionEditorModalProps {
  open: boolean;
  pluginId: string | null;
  declared: readonly PermissionKey[];
  store: PermissionStore;
  onClose: () => void;
  // race(R102):保存瞬间复检该插件在 live 列表仍存在。弹窗打开期间插件被另一窗口/操作卸载时
  // 返回 false → save 中止写入并关闭(防把已卸载插件的 ghost 权限写回 _permissions.json,同 id
  // 日后重装意外继承)。省略 = 不复检(无插件列表上下文的调用方,如测试/独立用途)。
  pluginStillExists?: () => boolean;
}

export interface PermissionSaveGroups {
  readonly toGrant: readonly PermissionKey[];
  readonly toDeny: readonly PermissionKey[];
}

const EMPTY_PERMISSION_SAVE_KEYS: readonly PermissionKey[] = [];
const EMPTY_PERMISSION_SAVE_GROUPS: PermissionSaveGroups = {
  toGrant: EMPTY_PERMISSION_SAVE_KEYS,
  toDeny: EMPTY_PERMISSION_SAVE_KEYS,
};

export function splitPermissionDecisionsForSave(
  decisions: ReadonlyMap<PermissionKey, boolean | null>,
): PermissionSaveGroups {
  if (decisions.size === 0) return EMPTY_PERMISSION_SAVE_GROUPS;
  let toGrant: PermissionKey[] | null = null;
  let toDeny: PermissionKey[] | null = null;
  let grantCount = 0;
  let denyCount = 0;

  for (const [perm, granted] of decisions) {
    if (granted === true) {
      toGrant ??= new Array<PermissionKey>(decisions.size);
      toGrant[grantCount++] = perm;
    } else if (granted === false) {
      toDeny ??= new Array<PermissionKey>(decisions.size);
      toDeny[denyCount++] = perm;
    }
  }

  if (toGrant !== null) toGrant.length = grantCount;
  if (toDeny !== null) toDeny.length = denyCount;
  return {
    toGrant: toGrant ?? EMPTY_PERMISSION_SAVE_KEYS,
    toDeny: toDeny ?? EMPTY_PERMISSION_SAVE_KEYS,
  };
}

/**
 * 回滚已成功的 deny:原为 granted 的项重新 grant;原为 denied 的无需动;原未决的项 store 无
 * 单键删除 API,保持 denied(fail-closed,下次启用不弹窗但仍不授权)。回滚失败只记录不再抛。
 */
async function restoreDenied(
  store: PermissionStore,
  pluginId: string,
  prior: readonly PermissionDecision[],
  denied: readonly PermissionKey[],
): Promise<void> {
  const deniedSet = new Set(denied);
  const regrant = prior
    .filter((d) => d.granted && deniedSet.has(d.permission))
    .map((d) => d.permission);
  if (regrant.length === 0) return;
  try {
    await store.grant(pluginId, regrant);
  } catch (err) {
    console.error('[PermissionEditorModal] rollback failed', err);
  }
}

export function PermissionEditorModal({
  open,
  pluginId,
  ...props
}: PermissionEditorModalProps) {
  if (!open || !pluginId) return null;
  return <PermissionEditorModalBody pluginId={pluginId} {...props} />;
}

type PermissionEditorModalBodyProps = Omit<
  PermissionEditorModalProps,
  'open' | 'pluginId'
> & {
  readonly pluginId: string;
};

function PermissionEditorModalBody({
  pluginId,
  declared,
  store,
  onClose,
  pluginStillExists,
}: PermissionEditorModalBodyProps) {
  const t = useT();
  const name = usePluginDisplayName(pluginId);
  // null = 未决, true = granted, false = denied
  const [decisions, setDecisions] = useState<Map<PermissionKey, boolean | null>>(
    () => new Map(),
  );
  // a11y(A46):保存失败须给可见 + live(role=alert)反馈,不能只 console.error(用户看似无响应)。
  const [saveFailed, setSaveFailed] = useState(false);
  // a11y(A59,A46 同族 load 侧):加载现有 decisions 失败须可见 + live 反馈,否则用户看到空/默认
  // 控件态、AT 不知未加载;同时禁用保存避免用错误的空态覆盖已存权限。
  const [loadFailed, setLoadFailed] = useState(false);
  // race(R23):初始 decisions 加载完成前禁用 checkbox/保存。否则弹窗一打开 checkbox 即可操作,
  // 而 store.get 异步返回后无条件 setDecisions(m) 会覆盖用户在加载完成前的勾选 → 误授/误拒权限
  // (尤其 IPC 慢/磁盘卡顿)。加载期 loading=true 门控交互,加载落地(成功/失败)后才可编辑。
  const [loading, setLoading] = useState(false);
  // race(R35,R23 save 侧对偶):保存写盘期间门控交互。否则 save() 取点击瞬间 decisions 快照、
  // await store.grant/deny 后**无条件 onClose()** —— 用户在写盘 await 期间又改 checkbox,迟到的旧
  // 保存会按旧快照关闭弹窗、新改动既没写入也无提示;双击 Save 还会重复排队同一批写入。saving=true
  // 时禁用 checkbox + Save(并防 save 重入),完成/失败后清除。
  const [saving, setSaving] = useState(false);
  // 保存回滚基线:加载时的已存决策(保存中途失败时按原值尽力恢复已成功的写)。
  const priorRef = useRef<readonly PermissionDecision[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    setLoading(true);
    void store
      .get(pluginId)
      .then((list) => {
        if (cancelled) return;
        priorRef.current = list;
        const m = new Map<PermissionKey, boolean | null>();
        for (const p of declared) m.set(p, null);
        for (const d of list) m.set(d.permission, d.granted);
        setDecisions(m);
        setLoading(false);
      })
      .catch((err) => {
        // 数据安全:读权限失败(EACCES/EIO → store 抛)→ 不假装为「未决」可写态,保持
        // 空表 + 记录;用户可取消/重试,save 时若仍失败也会被下方 try/catch 拦住不误存。
        if (cancelled) return;
        console.error('[PermissionEditorModal] load decisions failed', err);
        setLoadFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, declared, store]);

  const toggle = (perm: PermissionKey) => {
    setDecisions((m) => {
      const next = new Map(m);
      // null/false → true (granted),true → false (denied)
      next.set(perm, next.get(perm) === true ? false : true);
      return next;
    });
  };

  const save = async () => {
    // race(R35):保存重入守卫(双击 Save / 写盘 await 期间再次触发)—— 防重复排队同一批写入。
    if (saving) return;
    // race(R102,R50 同族):保存瞬间复检插件仍在 live 列表(覆盖父层 effect 关弹窗前的同帧点击)。
    // 已卸载则关弹窗不写,防 ghost 权限写回 _permissions.json。
    if (pluginStillExists && !pluginStillExists()) {
      onClose();
      return;
    }
    setSaveFailed(false);
    const { toGrant, toDeny } = splitPermissionDecisionsForSave(decisions);
    setSaving(true);
    // 数据安全:store 无批量写,grant/deny 是两次独立写盘。先 deny 后 grant —— 中途失败最多
    // 少授、不会多授(fail-closed);grant 失败时再把已成功 deny 的项按原值恢复(尽力而为),
    // 避免落成用户从未选择过的混合状态。
    let denied = false;
    try {
      if (toDeny.length > 0) {
        await store.deny(pluginId, toDeny);
        denied = true;
      }
      if (toGrant.length > 0) await store.grant(pluginId, toGrant);
    } catch (err) {
      if (denied) await restoreDenied(store, pluginId, priorRef.current, toDeny);
      // 数据安全:写盘失败时 store 抛(不再静默) → **不 onClose**(不假装已保存),
      // 保持 Modal 打开让用户重试;store 已保证 cache 未被半提交污染(写成功才提交)。
      // a11y(A46):同时给用户可见 + AT 可播报的失败反馈,不只 console.error。
      console.error('[PermissionEditorModal] save failed', err);
      setSaveFailed(true);
      return;
    } finally {
      setSaving(false);
    }
    onClose();
  };

  // 引用必须稳定(同 PermissionPrompt handleClose / ConfirmDialog):调用方传内联 onClose,
  // 打开期间父组件(安装进度 / 插件列表更新)重渲换新引用会让 Modal 焦点 effect 重跑,
  // 把焦点拉回第一个 checkbox。Esc / overlay 仍调最新的。
  const handleModalClose = useStableCallback(onClose);

  return (
    <Modal visible onClose={handleModalClose} aria-labelledby="permission-editor-title">
      {/* a11y(A13):dialog 关联标题。 */}
      <h2 id="permission-editor-title" className="mb-1 text-sm font-medium text-fg">
        {t('permissions.editor.title')}
      </h2>
      {/* 以名称称呼,id 作等宽副文本(同首次授权弹窗)。 */}
      <p className="mb-3 text-xs text-fg-muted">
        {t('permissions.editor.plugin_id_label')}{' '}
        {/* 名称由插件提供:可见化后放进 <code>(同授权弹窗)。 */}
        <span data-plugin-name>
          <UntrustedText text={name} />
        </span>
        {name !== pluginId && (
          <span className="block text-2xs text-fg-dim">
            <UntrustedText text={pluginId} />
          </span>
        )}
      </p>
      <ul className="mb-3 space-y-1">
        {declared.map((perm) => (
          <PermissionOptionRow
            key={perm}
            perm={perm}
            checked={decisions.get(perm) === true}
            onToggle={toggle}
            // race(R23):初始加载完成前禁用,防异步 load 结果覆盖用户提前的勾选。
            // race(R35):保存写盘期间禁用,防迟到 onClose 丢弃保存后改动。
            disabled={loading || loadFailed || saving}
          />
        ))}
      </ul>
      <div className="mb-4 rounded border border-line bg-panel-soft/40 px-3 py-2 text-xs text-fg-muted">
        {t('permissions.editor.next_enable_note_prefix')}
        <span className="text-fg">{t('permissions.editor.next_enable_emphasis')}</span>
        {t('permissions.editor.next_enable_note_suffix')}
      </div>
      {loadFailed && (
        // a11y(A59):加载失败的 live region 反馈;同时禁用保存,避免用空/默认态覆盖已存权限。
        <div className="mb-3 text-xs text-error" role="alert">
          {t('permissions.editor.load_failed')}
        </div>
      )}
      {saveFailed && (
        // a11y(A46):保存失败的 live region 反馈(失败 → role=alert/assertive),Modal 保持打开重试。
        <div className="mb-3 text-xs text-error" role="alert">
          {t('permissions.editor.save_failed')}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('permissions.editor.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          // race(R35):保存写盘期间禁用,防双击 Save 重复排队同一批写入。
          disabled={loadFailed || loading || saving}
        >
          {t('permissions.editor.save')}
        </Button>
      </div>
    </Modal>
  );
}
