// @vitest-environment jsdom
// perf E2 复审 #3:编辑引擎 chunk 加载失败须被 EditorPanel 内的局部边界接住 —— 面板其余部分
// (tab 栏等)照常渲染,引擎区显示可见错误 + 重试;重试新建 lazy 实例重新发起加载
// (React.lazy 会永久缓存首个 rejection,复用旧实例永远失败)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy, type ReactElement } from 'react';

const h = vi.hoisted(() => ({
  loadCode: null as unknown as () => Promise<{ default: () => ReactElement }>,
  createdCode: 0,
}));

vi.mock('../../panels/Editor/editor-engine-loaders', () => ({
  createLazyCodeEditor: () => {
    h.createdCode += 1;
    return lazy(() => h.loadCode());
  },
  createLazyMilkdownEditor: () =>
    lazy(async () => ({ default: () => <div data-testid="milkdown-editor" /> })),
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

import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { t } from '../../i18n';

beforeEach(() => {
  useEditorStore.setState({
    tabs: [
      { id: '/a.ts', filePath: '/a.ts', content: 'x', originalContent: 'x', dirty: false },
    ],
    activeTabId: '/a.ts',
    mode: 'edit',
  });
});
afterEach(() => cleanup());

describe('perf E2 — 编辑引擎加载失败的局部边界与重试', () => {
  it('CodeEditor chunk 加载失败 → 引擎区显示错误与重试,面板不崩;重试后加载成功', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.loadCode = () => Promise.reject(new Error('chunk load failed'));
      render(<EditorPanel />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(t('panels.editor.engine_load_failed'));
      // 面板其余部分(tab 栏)仍在
      expect(screen.getByText('a.ts')).toBeTruthy();

      h.loadCode = async () => ({
        default: () => <div data-testid="code-editor">ok</div>,
      });
      const createdBefore = h.createdCode;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('panels.editor.engine_load_retry') }));
      });

      expect(await screen.findByTestId('code-editor')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(h.createdCode).toBe(createdBefore + 1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
