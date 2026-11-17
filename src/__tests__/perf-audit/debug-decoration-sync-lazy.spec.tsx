// @vitest-environment jsdom
// perf E5:debug-decoration-sync 不再静态 import ./debug-decorations(CodeMirror 运行时)。
// 正常路径:CodeEditor 静态 import debug-decorations,其模块求值时向 sync 注册装饰实现 —— 有 view 时
// 实现必已就绪,同步语义不变(51-debug-breakpoint-ui/sync.spec 的同步断言全部保持)。
// 兜底路径(本文件):已有注册 view 但实现尚未加载时,sync 动态 import 装饰模块,加载完成后补做一次同步。

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
});

describe('perf E5 — 装饰实现未加载时按需动态加载并补做同步', () => {
  it('启动同步时实现未加载 → 动态 import 后对已注册 view 派发装饰', async () => {
    vi.resetModules(); // 全新模块图:debug-decorations 尚未被任何人 import
    const { startDebugDecorationSync } = await import(
      '../../panels/Editor/decorations/debug-decoration-sync'
    );
    const { createTab, useEditorStore } = await import('../../stores/editor.store');
    const { useDebugStore } = await import('../../stores/debug.store');

    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({ state: EditorState.create({ doc: 'a\nb\nc\n' }), parent });
    const dispatch = vi.spyOn(view, 'dispatch');

    const editor = useEditorStore.getState();
    editor.openTab(createTab('/repo/a.ts', view.state.doc.toString()));
    editor.registerView('/repo/a.ts', view);
    useDebugStore.setState({
      activeSessionId: null,
      sessions: new Map([
        [
          's1',
          {
            id: 's1',
            breakpoints: [{ file: '/repo/a.ts', line: 2, verified: true }],
            frames: [],
            scopes: [],
            variableRefs: new Map(),
            variablesCache: new Map(),
            lastStoppedOrder: 0,
          },
        ],
      ]),
    });

    const stop = startDebugDecorationSync();
    try {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      // 补做的同步带上了断点行(effects 非空)
      const spec = dispatch.mock.calls[0]![0] as { effects: unknown[] };
      expect(spec.effects.length).toBeGreaterThan(0);
    } finally {
      stop();
      view.destroy();
    }
  });
});
