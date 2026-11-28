// 工作区信任的界面(对齐 VSCode workspace.contribution 的状态栏项 / workspaceTrustEditor 的管理页,最小版):
// - 状态栏「受限模式」项(盾牌图标 + tooltip 说明被禁用的功能,点击打开管理);
// - 管理工作区信任对话框(design Modal):当前文件夹状态、信任 / 不信任、已信任文件夹列表(可删除);
// - 授权弹窗(插件权限 / agent 授权)里的「此文件夹不受信任」提示。
// 「信任」只请 main 弹原生信任对话框(由用户在原生对话框里决定),renderer 没有直接置信任的入口;「不信任」/ 删除条目只收紧。
// BDD: src/__tests__/workspace-trust/

import { useCallback, useEffect, useId, useState } from 'react';
import { Button, IconButton, Modal } from '@/design';
import { useT, t as translate } from '@/i18n';
import { coApi } from '@/lib/co-api';
import { createLatestGuard } from '@/lib/latest-wins';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { isRestrictedRoot, useWorkspaceTrustStore } from '@/stores/workspace-trust.store';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import type { WorkspaceTrustInfo } from '../../../electron/shared/workspace-trust';

const PRODUCT = 'Continuo';

/** 盾牌图标(VSCode codicon shield 的语义;lucide shield 字形)。仅装饰。 */
function ShieldIcon({ size = 12 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** 受限模式下被禁用 / 收紧的功能(状态栏 tooltip 与管理对话框共用)。 */
function restrictedFeatures(): string[] {
  return [translate('workspace_trust.feature.git'), translate('workspace_trust.feature.prompts')];
}

/** 本窗口当前文件夹是否已知处于受限模式。 */
export function useWorkspaceRestricted(): boolean {
  const root = useWorkspaceStore((s) => s.root);
  return useWorkspaceTrustStore((s) => isRestrictedRoot(s.state, root));
}

export const MANAGE_WORKSPACE_TRUST_COMMAND_ID = 'workbench.trust.manage';

export function openManageWorkspaceTrust(): void {
  useWorkspaceTrustStore.getState().setManageOpen(true);
}

/** 命令面板「工作区: 管理工作区信任」(VSCode workbench.trust.manage)。 */
export function manageWorkspaceTrustCommandSpec(): CommandSpec {
  return {
    id: MANAGE_WORKSPACE_TRUST_COMMAND_ID,
    title: 'Manage Workspace Trust',
    titleKey: 'commands.workspaces.manage_trust.title',
    category: 'Workspaces',
    categoryKey: 'commands.workspaces.category',
    fn: openManageWorkspaceTrust,
  };
}

/**
 * 状态栏「受限模式」项(VSCode status.workspaceTrust:左侧最前、prominent)。未受信任时显示,信任后即消失。
 * native button:24px 状态栏内的行内文本按钮(同状态栏其它项,design Button 最小高度超出状态栏);颜色走语义 token。
 */
export function RestrictedModeStatusItem({ className }: { readonly className: string }) {
  const t = useT();
  if (!useWorkspaceRestricted()) return null;
  const features = restrictedFeatures()
    .map((f) => `• ${f}`)
    .join('\n');
  return (
    <button
      type="button"
      data-restricted-mode=""
      onClick={openManageWorkspaceTrust}
      title={t('workspace_trust.status.tooltip', { features })}
      // VSCode ariaLabel「受限模式: 某些功能已禁用，因为此文件夹不受信任。」:以可见文字开头(WCAG 2.5.3 Label in Name)
      aria-label={t('workspace_trust.status.aria')}
      className={`${className} gap-1 text-fg`}
    >
      <span className="text-warning">
        <ShieldIcon />
      </span>
      {t('workspace_trust.status.text')}
    </button>
  );
}

/** 授权弹窗里的「此文件夹不受信任(受限模式)」提示;已受信任 / 未打开文件夹 / 状态未知 → 不渲染。 */
export function UntrustedWorkspaceNote() {
  const t = useT();
  if (!useWorkspaceRestricted()) return null;
  return (
    <p className="mb-3 flex items-start gap-1.5 text-xs text-fg" data-untrusted-workspace-note="">
      <span className="mt-px shrink-0 text-warning">
        <ShieldIcon size={14} />
      </span>
      <span className="min-w-0">{t('workspace_trust.note')}</span>
    </p>
  );
}

/** 管理工作区信任对话框(manageOpen 时挂载)。 */
export function WorkspaceTrustModal() {
  const open = useWorkspaceTrustStore((s) => s.manageOpen);
  return open ? <WorkspaceTrustModalBody /> : null;
}

function WorkspaceTrustModalBody() {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();
  const state = useWorkspaceTrustStore((s) => s.state);
  const [info, setInfo] = useState<WorkspaceTrustInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [guard] = useState(createLatestGuard);
  const close = useCallback(() => useWorkspaceTrustStore.getState().setManageOpen(false), []);

  const reload = useCallback(async () => {
    const isLatest = guard.begin();
    try {
      const r = await coApi.workspaceTrust.getInfo();
      if (!isLatest()) return;
      if (r.ok) setInfo(r.data);
      else notifyFailure(r);
    } catch (err) {
      if (isLatest()) notifyThrownError(err);
    }
  }, [guard]);
  // main 推来新状态(信任 / 不信任 / 条目变化 / 换根)→ 重取
  useEffect(() => {
    void reload();
  }, [reload, state]);

  const act = async (run: () => Promise<{ ok: boolean; code?: string; message?: string }>): Promise<void> => {
    setBusy(true);
    try {
      const r = await run();
      if (!r.ok) notifyFailure({ code: r.code ?? 'UNKNOWN', message: r.message ?? t('workspace_trust.manage.failed') });
    } catch (err) {
      notifyThrownError(err);
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const trustedBy = new Set(info?.trustedBy ?? []);
  return (
    <Modal visible onClose={close} size="md" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <h2 id={titleId} className="mb-1 flex items-center gap-1.5 text-sm font-medium text-fg">
        <span className="text-warning">
          <ShieldIcon size={14} />
        </span>
        {t('commands.workspaces.manage_trust.title')}
      </h2>
      {info === null ? null : (
        <>
          <div id={descriptionId} className="mb-3 text-xs text-fg-muted">
            {info.root === null ? (
              <p>{t('workspace_trust.manage.no_folder')}</p>
            ) : (
              <>
                <p className="mb-1 font-medium text-fg" data-trust-header="">
                  {info.trusted ? t('workspace_trust.manage.trusted_header') : t('workspace_trust.manage.untrusted_header')}
                </p>
                <p className="mb-1">
                  {info.trusted
                    ? t('workspace_trust.manage.trusted_description')
                    : t('workspace_trust.manage.untrusted_description', { product: PRODUCT })}
                </p>
                <p className="mb-1 break-all font-mono text-fg">{info.root}</p>
                {info.trusted ? null : (
                  <>
                    <p className="mb-1">{t('workspace_trust.manage.untrusted_subtitle')}</p>
                    <ul className="list-disc pl-5">
                      {restrictedFeatures().map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </>
                )}
                {info.trusted && !info.canUntrust && info.trustedBy.length > 0 ? (
                  <p className="mt-1">{t('workspace_trust.manage.trusted_via')}</p>
                ) : null}
              </>
            )}
          </div>
          {info.root !== null && (!info.trusted || info.canUntrust) ? (
            <div className="mb-4 flex justify-start">
              {info.trusted ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act(() => coApi.workspaceTrust.removeFolder(info.trustedBy[0]!))}
                >
                  {t('workspace_trust.manage.dont_trust')}
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => coApi.workspaceTrust.requestTrust())}>
                  {t('workspace_trust.manage.trust')}
                </Button>
              )}
            </div>
          ) : null}
          <h3 className="mb-1 text-xs font-medium text-fg">{t('workspace_trust.manage.folders_title')}</h3>
          <p className="mb-2 text-xs text-fg-muted">
            {info.folders.length > 0
              ? t('workspace_trust.manage.folders_description')
              : t('workspace_trust.manage.folders_empty')}
          </p>
          {info.folders.length > 0 ? (
            <ul className="mb-3 max-h-60 overflow-auto rounded border border-line" aria-label={t('workspace_trust.manage.folders_title')}>
              {info.folders.map((folder) => (
                <li
                  key={folder}
                  data-trusted-folder={folder}
                  className="flex items-center gap-2 border-b border-line px-2 py-1 text-xs last:border-b-0"
                >
                  <span className={`min-w-0 flex-1 break-all font-mono ${trustedBy.has(folder) ? 'font-bold text-fg' : 'text-fg-muted'}`}>
                    {folder}
                  </span>
                  <IconButton
                    size="xs"
                    disabled={busy}
                    title={t('workspace_trust.manage.remove')}
                    aria-label={t('common.label_detail', { label: t('workspace_trust.manage.remove'), detail: folder })}
                    onClick={() => void act(() => coApi.workspaceTrust.removeFolder(folder))}
                  >
                    ×
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={close} data-autofocus="">
          {t('workspace_trust.manage.close')}
        </Button>
      </div>
    </Modal>
  );
}
