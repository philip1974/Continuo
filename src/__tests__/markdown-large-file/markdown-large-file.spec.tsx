// @vitest-environment jsdom
// BDD:较大 Markdown 以源码模式打开(见同目录 README)。
import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MILKDOWN_LARGE_DOC_CHARS,
  createTab,
  getEffectiveMode,
  useEditorStore,
  usesMilkdownEngine,
} from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { t } from '../../i18n';

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}));

vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: ({ readonly, onViewReady }: { readonly?: boolean; onViewReady?: () => void }) => {
    useEffect(() => onViewReady?.(), [onViewReady]);
    return <div data-testid="milkdown-editor" data-readonly={String(!!readonly)} />;
  },
}));

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: { readFile: vi.fn(), writeFile: vi.fn(async () => ({ ok: true, data: undefined })), onDirChanged: vi.fn(() => vi.fn()) },
    shell: { openExternal: vi.fn() },
  },
}));

vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

const BIG = '/w/big.md';
const BIG2 = '/w/big2.md';
const SMALL = '/w/small.md';
const big = `# Big\n\n${'word '.repeat(Math.ceil(MILKDOWN_LARGE_DOC_CHARS / 5) + 10)}\n`;

const st = () => useEditorStore.getState();
const tab = (id: string) => st().tabs.find((x) => x.id === id) ?? null;

async function flushLazyEditors() {
  await act(async () => {
    await import('../../panels/Editor/CodeEditor');
    await import('../../panels/Editor/MilkdownEditor');
  });
}

beforeEach(() => {
  useEditorStore.setState({
    tabs: [createTab(BIG, big), createTab(BIG2, big), createTab(SMALL, '# small\n')],
    activeTabId: BIG,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'edit',
  });
});

afterEach(cleanup);

describe('判定与实际模式', () => {
  it('窗口级模式为编辑 / 预览时,较大的 Markdown 实际为源码;窗口级模式不被改写;小文件照常', () => {
    expect(getEffectiveMode(tab(BIG))).toBe('source');
    expect(usesMilkdownEngine(BIG, tab(BIG))).toBe(false);
    expect(getEffectiveMode(tab(SMALL))).toBe('edit');
    st().setMode('preview');
    expect(getEffectiveMode(tab(BIG))).toBe('source');
    expect(getEffectiveMode(tab(SMALL))).toBe('preview');
    expect(st().mode).toBe('preview');
  });

  it('恰好在阈值内不降级;非 Markdown 不受影响', () => {
    st().openTab(createTab('/w/edge.md', 'x'.repeat(MILKDOWN_LARGE_DOC_CHARS)));
    expect(getEffectiveMode(tab('/w/edge.md'))).toBe('edit');
    st().openTab(createTab('/w/big.ts', big));
    expect(usesMilkdownEngine('/w/big.ts', tab('/w/big.ts'))).toBe(false);
  });

  it('接受只对该 tab 生效;编辑中跨过阈值不改判定,外部重新读盘时重算', () => {
    st().acceptLargeMilkdown(BIG);
    expect(getEffectiveMode(tab(BIG))).toBe('edit');
    expect(getEffectiveMode(tab(BIG2))).toBe('source');
    st().updateContent(SMALL, big);
    expect(getEffectiveMode(tab(SMALL))).toBe('edit');
    st().reloadFromDisk(BIG2, '# now small\n');
    expect(getEffectiveMode(tab(BIG2))).toBe('edit');
  });
});

describe('编辑区', () => {
  it('降级时以源码显示并给一行提示;窗口级模式为源码时不提示', async () => {
    const { container, unmount } = render(<EditorPanel />);
    await flushLazyEditors();
    expect(screen.getByTestId('code-editor')).not.toBeNull();
    expect(screen.queryByTestId('milkdown-editor')).toBeNull();
    expect(container.textContent).toContain(t('panels.editor.milkdownLarge.banner'));
    expect(screen.getByRole('radio', { name: t('panels.editor.mode.source') }).getAttribute('aria-checked')).toBe('true');
    unmount();

    useEditorStore.setState({ mode: 'source' });
    const again = render(<EditorPanel />);
    await flushLazyEditors();
    expect(again.container.textContent).not.toContain(t('panels.editor.milkdownLarge.banner'));
  });

  it('手动切到预览:先显示「正在渲染」,随后按预览渲染、提示消失;窗口级模式随用户选择', async () => {
    const { container } = render(<EditorPanel />);
    await flushLazyEditors();
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: t('panels.editor.mode.preview') }));
    });
    expect(container.textContent).toContain(t('panels.editor.milkdownLarge.rendering'));
    await waitFor(() => expect(screen.getByTestId('milkdown-editor').getAttribute('data-readonly')).toBe('true'));
    await waitFor(() => expect(container.textContent).not.toContain(t('panels.editor.milkdownLarge.rendering')));
    expect(container.textContent).not.toContain(t('panels.editor.milkdownLarge.banner'));
    expect(st().mode).toBe('preview');
    expect(tab(BIG)?.milkdownLargeAccepted).toBe(true);
    expect(tab(BIG2)?.milkdownLargeAccepted).toBeUndefined();
  });
});
