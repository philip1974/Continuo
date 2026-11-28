// @vitest-environment jsdom
// BDD: workspace-trust / 界面:状态栏「受限模式」项(盾牌 + tooltip + 点击打开管理)、管理工作区信任对话框(信任只请 main 弹
// 原生对话框、不信任 / 删除只收紧)、命令面板命令、授权弹窗提示、git 装饰随信任变化即时刷新。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { WorkspaceTrustInfo, WorkspaceTrustState } from '../../../electron/shared/workspace-trust';

const h = vi.hoisted(() => ({
  getInfo: vi.fn(),
  requestTrust: vi.fn(),
  removeFolder: vi.fn(),
  onChanged: null as null | ((s: WorkspaceTrustState) => void),
  gitStatus: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    workspaceTrust: {
      getInfo: h.getInfo,
      requestTrust: h.requestTrust,
      removeFolder: h.removeFolder,
      onChanged: (cb: (s: WorkspaceTrustState) => void) => {
        h.onChanged = cb;
        return () => undefined;
      },
    },
    git: { status: h.gitStatus },
    fs: { onDirChanged: () => () => undefined },
  },
}));

import {
  MANAGE_WORKSPACE_TRUST_COMMAND_ID,
  RestrictedModeStatusItem,
  UntrustedWorkspaceNote,
  WorkspaceTrustModal,
  manageWorkspaceTrustCommandSpec,
} from '../../shell/workspace-trust/WorkspaceTrust';
import { startWorkspaceTrustSync, useWorkspaceTrustStore } from '../../stores/workspace-trust.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useGitStatus, GIT_REFRESH_DEBOUNCE_MS } from '../../panels/Explorer/hooks/useGitStatus';
// 测试环境默认 locale = zh
import { zh } from '../../../electron/shared/i18n-locales/zh';

const ROOT = '/work/proj';
const push = (s: WorkspaceTrustState) => act(() => h.onChanged!(s));
const info = (over: Partial<WorkspaceTrustInfo> = {}): WorkspaceTrustInfo => ({
  root: ROOT,
  trusted: false,
  trustedBy: [],
  canUntrust: false,
  folders: [],
  ...over,
});

beforeEach(() => {
  startWorkspaceTrustSync();
  useWorkspaceStore.setState({ root: ROOT });
  useWorkspaceTrustStore.setState({ state: null, manageOpen: false });
  h.getInfo.mockResolvedValue({ ok: true, data: info() });
  h.requestTrust.mockResolvedValue({ ok: true, data: false });
  h.removeFolder.mockResolvedValue({ ok: true, data: undefined });
  h.gitStatus.mockResolvedValue({ ok: true, data: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('状态栏「受限模式」项', () => {
  it('main 推「未受信任」→ 显示(tooltip 列出被禁用的功能);推「受信任」→ 即时消失;状态未知 / 别的根 → 不显示', () => {
    render(<RestrictedModeStatusItem className="" />);
    expect(screen.queryByText(zh['workspace_trust.status.text'])).toBeNull();
    push({ root: '/other', trusted: false });
    expect(screen.queryByText(zh['workspace_trust.status.text'])).toBeNull();
    push({ root: ROOT, trusted: false });
    const item = screen.getByRole('button', { name: new RegExp(zh['workspace_trust.status.text']) });
    expect(item.getAttribute('title')).toContain(zh['workspace_trust.feature.git']);
    expect(item.querySelector('svg')).not.toBeNull();
    push({ root: ROOT, trusted: true });
    expect(screen.queryByText(zh['workspace_trust.status.text'])).toBeNull();
  });

  it('点击 → 打开管理工作区信任对话框', async () => {
    render(
      <>
        <RestrictedModeStatusItem className="" />
        <WorkspaceTrustModal />
      </>,
    );
    push({ root: ROOT, trusted: false });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['workspace_trust.status.text']) }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByText(zh['workspace_trust.manage.untrusted_header'])).toBeTruthy();
  });
});

describe('管理工作区信任', () => {
  it('命令面板命令「工作区: 管理工作区信任」打开对话框', () => {
    const spec = manageWorkspaceTrustCommandSpec();
    expect(spec).toMatchObject({
      id: MANAGE_WORKSPACE_TRUST_COMMAND_ID,
      titleKey: 'commands.workspaces.manage_trust.title',
      categoryKey: 'commands.workspaces.category',
    });
    void spec.fn();
    expect(useWorkspaceTrustStore.getState().manageOpen).toBe(true);
  });

  it('未受信任:「信任」只调用 requestTrust(由 main 弹原生对话框决定),不调用任何置信任的接口;结果推来后界面更新', async () => {
    useWorkspaceTrustStore.setState({ manageOpen: true });
    render(<WorkspaceTrustModal />);
    const trustButton = await screen.findByRole('button', { name: zh['workspace_trust.manage.trust'] });
    h.requestTrust.mockResolvedValueOnce({ ok: true, data: true });
    h.getInfo.mockResolvedValue({ ok: true, data: info({ trusted: true, trustedBy: [ROOT], canUntrust: true, folders: [ROOT] }) });
    fireEvent.click(trustButton);
    await waitFor(() => expect(h.requestTrust).toHaveBeenCalledWith());
    expect(h.removeFolder).not.toHaveBeenCalled();
    push({ root: ROOT, trusted: true });
    expect(await screen.findByText(zh['workspace_trust.manage.trusted_header'])).toBeTruthy();
    expect(screen.getByRole('button', { name: zh['workspace_trust.manage.dont_trust'] })).toBeTruthy();
  });

  it('直接受信任:「不信任」移除本文件夹条目;列表里的删除按钮移除对应条目;经上级受信任时不显示「不信任」并加粗上级', async () => {
    h.getInfo.mockResolvedValue({
      ok: true,
      data: info({ trusted: true, trustedBy: [ROOT], canUntrust: true, folders: ['/a', ROOT] }),
    });
    useWorkspaceTrustStore.setState({ manageOpen: true });
    const view = render(<WorkspaceTrustModal />);
    fireEvent.click(await screen.findByRole('button', { name: zh['workspace_trust.manage.dont_trust'] }));
    await waitFor(() => expect(h.removeFolder).toHaveBeenCalledWith(ROOT));
    fireEvent.click(screen.getByRole('button', { name: `${zh['workspace_trust.manage.remove']}：/a` }));
    await waitFor(() => expect(h.removeFolder).toHaveBeenCalledWith('/a'));
    view.unmount();

    h.getInfo.mockResolvedValue({
      ok: true,
      data: info({ trusted: true, trustedBy: ['/work'], canUntrust: false, folders: ['/work'] }),
    });
    useWorkspaceTrustStore.setState({ manageOpen: false });
    useWorkspaceTrustStore.setState({ manageOpen: true });
    render(<WorkspaceTrustModal />);
    expect(await screen.findByText(zh['workspace_trust.manage.trusted_via'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: zh['workspace_trust.manage.dont_trust'] })).toBeNull();
    expect(screen.getByText('/work').className).toContain('font-bold');
  });
});

describe('授权弹窗提示', () => {
  it('受限模式下显示「此文件夹不受信任」提示;受信任时不显示', () => {
    render(<UntrustedWorkspaceNote />);
    expect(screen.queryByText(zh['workspace_trust.note'])).toBeNull();
    push({ root: ROOT, trusted: false });
    expect(screen.getByText(zh['workspace_trust.note'])).toBeTruthy();
    push({ root: ROOT, trusted: true });
    expect(screen.queryByText(zh['workspace_trust.note'])).toBeNull();
  });
});

describe('git 装饰随信任即时刷新', () => {
  it('本根的信任状态变化 → 重新查询 git 状态(无需重载窗口);别的根的推送不触发', async () => {
    vi.useFakeTimers();
    renderHook(() => useGitStatus(ROOT, true, true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.gitStatus).toHaveBeenCalledTimes(1);
    push({ root: '/other', trusted: true });
    await act(async () => {
      vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10);
    });
    expect(h.gitStatus).toHaveBeenCalledTimes(1);
    push({ root: ROOT, trusted: true });
    await act(async () => {
      vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10);
    });
    expect(h.gitStatus).toHaveBeenCalledTimes(2);
  });
});
