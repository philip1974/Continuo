// @vitest-environment jsdom
// BDD: editor-search-git-decorations / 编辑器 tab:标题颜色 + 字母、悬浮提示带状态、可访问名称不变、与预览 / 脏 / 已删除叠加、设置开关、即时更新
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { GitStatusSnapshot } from '../../../electron/shared/git-status';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  dirListeners: new Set<(path: string) => void>(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    git: { status: h.status },
    fs: {
      onDirChanged: (cb: (path: string) => void) => {
        h.dirListeners.add(cb);
        return () => h.dirListeners.delete(cb);
      },
    },
  },
}));

import { setLocale } from '@/i18n';
import { EditorHeader } from '../../panels/Editor/EditorHeader';
import { GIT_REFRESH_DEBOUNCE_MS } from '../../panels/Explorer/hooks/useGitStatus';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { coApp } from '../../plugins/co-app';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';
import {
  EDITOR_DECORATIONS_BADGES,
  EDITOR_DECORATIONS_COLORS,
} from '../../plugins/settings/core-setting-specs';

const ENTRIES: GitStatusSnapshot['entries'] = [
  ['m.ts', 'modified', 'M'],
  ['new/', 'untracked', 'U'],
  ['out.log', 'ignored', ''],
  ['gone.ts', 'deleted', 'D'],
];
const snap = (entries: GitStatusSnapshot['entries']) => ({ ok: true as const, data: { root: '/w', entries } });
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function openTabs(...paths: string[]): void {
  const st = useEditorStore.getState();
  for (const p of paths) st.openTab(createTab(p, ''));
}

beforeEach(() => {
  vi.useFakeTimers();
  setLocale('zh');
  h.status.mockReset();
  h.status.mockResolvedValue(snap(ENTRIES));
  (coApp as { editorActions: EditorActionRegistry }).editorActions = new EditorActionRegistry();
  useSettingsValuesStore.setState({ values: {} });
  useWorkspaceStore.setState({ root: '/w' });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLocale('en');
  useWorkspaceStore.setState({ root: null });
  h.dirListeners.clear();
});

const tab = (name: string | RegExp) => screen.getByRole('tab', { name });
const titleOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-git-title]');
const letterOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-git-letter]');

async function renderHeader() {
  const r = render(<EditorHeader onCloseRequest={vi.fn()} />);
  await flush();
  return r;
}

describe('tab 标题按 git 状态着色 + 字母', () => {
  it('修改 / 未跟踪目录下的文件 → 颜色 + 字母;激活与非激活 tab 都着色', async () => {
    openTabs('/w/m.ts', '/w/new/x.ts');
    await renderHeader();
    expect(tab('x.ts').getAttribute('aria-selected')).toBe('true');
    expect(titleOf(tab('m.ts'))?.className).toContain('text-git-modified');
    expect(letterOf(tab('m.ts'))?.textContent).toBe('M');
    expect(letterOf(tab('m.ts'))?.className).toContain('text-git-modified');
    expect(letterOf(tab('m.ts'))?.getAttribute('aria-hidden')).toBe('true');
    // 字母放在 tab 的 trailing 槽位(会截断的标题之外):长文件名截断时字母仍可见(VSCode)
    expect(letterOf(tab('m.ts'))?.closest('.wm-tab-nav-item__label')).toBeNull();
    expect(letterOf(tab('m.ts'))?.closest('.wm-tab-nav-item__trailing')).not.toBeNull();
    expect(titleOf(tab('x.ts'))?.className).toContain('text-git-untracked');
    expect(letterOf(tab('x.ts'))?.textContent).toBe('U');
  });

  it('磁盘上 NFD 的文件名(如韩文)与 git 的 NFC 路径对得上 → 照常着色 + 字母', async () => {
    const nfd = '\u1112\u1161\u11ab.ts';
    h.status.mockResolvedValue(snap([[nfd.normalize('NFC'), 'modified', 'M']]));
    openTabs(`/w/${nfd}`);
    await renderHeader();
    const t = screen.getByRole('tab');
    expect(titleOf(t)?.className).toContain('text-git-modified');
    expect(letterOf(t)?.textContent).toBe('M');
  });

  it('忽略项置灰无字母;无状态 / 工作区外 → 不装饰', async () => {
    openTabs('/w/out.log', '/w/clean.ts', '/elsewhere/m.ts');
    await renderHeader();
    expect(titleOf(tab('out.log'))?.className).toContain('text-git-ignored');
    expect(letterOf(tab('out.log'))).toBeNull();
    expect(titleOf(tab('clean.ts'))).toBeNull();
    expect(titleOf(tab('m.ts'))).toBeNull();
  });

  it('悬浮提示追加状态;可访问名称不变(VSCode tab aria-label 不含 git 状态)', async () => {
    openTabs('/w/m.ts');
    await renderHeader();
    expect(tab('m.ts').getAttribute('title')).toBe('/w/m.ts · 已修改');
    expect(screen.queryByRole('tab', { name: /已修改/ })).toBeNull();
  });

  it('与预览斜体、脏圆点叠加', async () => {
    openTabs('/w/m.ts');
    useEditorStore.getState().openTab(createTab('/w/new/p.ts', ''), { preview: true });
    act(() => useEditorStore.getState().updateContent('/w/m.ts', 'x'));
    await renderHeader();
    const preview = tab(/^p\.ts/);
    expect(preview.querySelector('.italic')).not.toBeNull();
    expect(titleOf(preview)?.className).toContain('text-git-untracked');
    expect(tab('m.ts').getAttribute('data-dirty')).toBe('true');
    expect(titleOf(tab('m.ts'))?.className).toContain('text-git-modified');
  });

  it('已删除(orphaned):删除线标题着删除色,「(已删除)」不着色', async () => {
    openTabs('/w/gone.ts');
    // 只有脏 tab 会因文件被删而保留为 orphaned
    act(() => {
      useEditorStore.getState().updateContent('/w/gone.ts', 'x');
      useEditorStore.getState().setOrphaned('/w/gone.ts', true);
    });
    await renderHeader();
    const el = screen.getByRole('tab');
    const title = titleOf(el)!;
    expect(title.className).toContain('text-git-deleted');
    expect(title.className).toContain('line-through');
    expect(title.textContent).toBe('gone.ts');
  });
});

describe('设置', () => {
  it('默认:颜色与字母都开(VSCode workbench.editor.decorations 默认 badges / colors 都 true)', () => {
    expect(EDITOR_DECORATIONS_COLORS.default).toBe(true);
    expect(EDITOR_DECORATIONS_BADGES.default).toBe(true);
  });

  it('colors=false → 不着色(字母仍在);badges=false → 无字母(颜色仍在);即时生效', async () => {
    openTabs('/w/m.ts');
    await renderHeader();
    act(() => useSettingsValuesStore.setState({ values: { [EDITOR_DECORATIONS_COLORS.id]: false } }));
    expect(titleOf(tab('m.ts'))?.className ?? '').not.toContain('text-git-');
    expect(letterOf(tab('m.ts'))?.textContent).toBe('M');
    act(() => useSettingsValuesStore.setState({ values: { [EDITOR_DECORATIONS_BADGES.id]: false } }));
    expect(titleOf(tab('m.ts'))?.className).toContain('text-git-modified');
    expect(letterOf(tab('m.ts'))).toBeNull();
  });

  it('两项都关 → 不查询 git,悬浮提示只有路径', async () => {
    useSettingsValuesStore.setState({
      values: { [EDITOR_DECORATIONS_COLORS.id]: false, [EDITOR_DECORATIONS_BADGES.id]: false },
    });
    openTabs('/w/m.ts');
    await renderHeader();
    expect(h.status).not.toHaveBeenCalled();
    expect(tab('m.ts').getAttribute('title')).toBe('/w/m.ts');
  });

  it('没有 tab → 不查询', async () => {
    await renderHeader();
    expect(h.status).not.toHaveBeenCalled();
  });
});

describe('即时更新', () => {
  it('文件变化后刷新:干净文件变为修改 → tab 着色', async () => {
    h.status.mockResolvedValue(snap([]));
    openTabs('/w/clean.ts');
    await renderHeader();
    expect(titleOf(tab('clean.ts'))).toBeNull();
    h.status.mockResolvedValue(snap([['clean.ts', 'modified', 'M']]));
    for (const cb of h.dirListeners) cb('/w');
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    await flush();
    expect(titleOf(tab('clean.ts'))?.className).toContain('text-git-modified');
  });
});
