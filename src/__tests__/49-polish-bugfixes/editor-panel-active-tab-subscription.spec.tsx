// @vitest-environment jsdom
// 打磨 R27(codex 性能):EditorPanel 只订阅 active tab 对象,不再订阅整份 tabs。
// 非 active tab 的 updateContent/markSaved 等只替换该 tab 对象,active tab 引用
// 不变 → selector 返同一对象 → EditorPanel 主体不重渲(Profiler 验证)。
import { Profiler } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, act } from '@testing-library/react';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <div data-testid="code-editor">{value}</div>
  ),
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

function txt(id: string, content: string, originalContent = content) {
  return {
    id,
    filePath: id,
    content,
    originalContent,
    dirty: content !== originalContent,
  };
}

beforeEach(() => {
  useEditorStore.setState({
    // /b.txt 预置为已 dirty(content≠original):后续改它 content 时 dirty 仍 true,
    // chrome(id/filePath/dirty)不变 → 隔离 EditorHeader 的 R23 窄订阅,只测
    // EditorPanel 本体是否因非 active tab 变化重渲。
    tabs: [txt('/a.txt', 'aaa'), txt('/b.txt', 'bbb', 'orig-b')],
    activeTabId: '/a.txt',
    mode: 'edit',
  });
});
afterEach(() => cleanup());

describe('打磨 R27 — EditorPanel 只订阅 active tab', () => {
  it('模式切换 options 按 locale memoize,不在每次 render 裸 MODE_IDS.map', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Editor/EditorPanel.tsx'), 'utf8');

    expect(src).toContain('const modeOptions = useMemo(');
    expect(src).toContain('[locale]');
    expect(src).not.toContain('const modeOptions = MODE_IDS.map');
  });

  it('模式切换 options 用预分配数组构造,避免 MODE_IDS.map callback 分配', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Editor/EditorPanel.tsx'), 'utf8');

    expect(src).not.toContain('return MODE_IDS.map');
    expect(src).toContain('new Array<SegmentedControlOption<EditorMode>>(');
    expect(src).toContain('MODE_IDS.length');
  });

  it('active markdown 判定复用派生值,不在主体和 toolbar 各算一次', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Editor/EditorPanel.tsx'), 'utf8');

    expect(src).toContain('const activeIsMarkdown =');
    expect(src).toContain('} else if (activeIsMarkdown) {');
    expect(src).toContain('{activeIsMarkdown && (');
    expect(src).not.toContain('} else if (isMarkdownPath(activeTab.filePath)) {');
    expect(src).not.toContain('{activeTab && isMarkdownPath(activeTab.filePath) && (');
  });

  it('非 active tab content 变化(dirty 不变)→ EditorPanel 不重渲', () => {
    const onRender = vi.fn();
    render(
      <Profiler id="ep" onRender={onRender}>
        <EditorPanel />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    act(() => {
      // /b.txt 仍 dirty(≠ 'orig-b'),其 chrome 不变;active /a.txt 引用不变。
      useEditorStore.getState().updateContent('/b.txt', 'bbb changed bg');
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('active tab content 变化 → 重渲 + 主体更新', () => {
    const { getByTestId } = render(<EditorPanel />);
    expect(getByTestId('code-editor').textContent).toBe('aaa');

    act(() => {
      useEditorStore.getState().updateContent('/a.txt', 'aaa typed more');
    });

    expect(getByTestId('code-editor').textContent).toBe('aaa typed more');
  });

  it('Cmd/Ctrl+S 大写 key 不调用 toLowerCase 也走保存快捷键判断', () => {
    const { container } = render(<EditorPanel />);
    const root = container.firstElementChild;
    if (!root) throw new Error('missing editor root');
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      fireEvent.keyDown(root, { key: 'S', metaKey: true });
      expect(
        lowerSpy.mock.contexts.some((ctx) => String(ctx) === 'S'),
      ).toBe(false);
    } finally {
      lowerSpy.mockRestore();
    }
  });
});
