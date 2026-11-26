// @vitest-environment jsdom
// BDD: editor-find-keybindings 第 5 条 —— 菜单「编辑 → 查找」/ 命令面板的「查找」(actions.find)在 Markdown 编辑 / 预览(Milkdown,
// 真实 Crepe)里打开其查找条(焦点在正文且有单行选区 → 带入选区);「替换」静默。见同目录 README。
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { TextSelection } from '@milkdown/kit/prose/state';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { clearMarkdownFindSessions } from '../../panels/Editor/markdown-find';
import { runTextCommand } from '../../panels/Editor/editor-text-commands';
import { t } from '../../i18n';
import { createTab, useEditorStore } from '../../stores/editor.store';

const mocks = vi.hoisted(() => ({ instances: [] as CrepeType[] }));
vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      mocks.instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({ coApi: { fs: { readImage: vi.fn() } } }));

const TAB = '/w/a.md';

beforeEach(() => {
  const tab = createTab(TAB, '');
  useEditorStore.setState({
    tabs: [tab],
    activeTabId: TAB,
    groups: [{ id: 'editor', tabIds: [TAB], activeTabId: TAB }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  mocks.instances.length = 0;
  clearMarkdownFindSessions();
});

interface PmView {
  readonly state: {
    readonly doc: { textBetween(from: number, to: number): string; readonly content: { readonly size: number } };
    readonly tr: { setSelection(sel: unknown): unknown };
  };
  dispatch(tr: unknown): void;
}

async function mount(markdown: string, readonly = false) {
  const utils = render(<MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={markdown} readonly={readonly} />);
  for (let i = 0; i < 100; i++) {
    try {
      const view = mocks.instances.at(-1)?.editor.ctx.get<PmView, 'editorView'>('editorView');
      if (view?.state) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
        return { ...utils, view, pm: utils.container.querySelector<HTMLElement>('.ProseMirror')! };
      }
    } catch {
      /* 未就绪 */
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('Crepe 未挂载');
}

const queryFindInput = () => screen.queryByRole('textbox', { name: t('editor.cm.find') }) as HTMLInputElement | null;
const run = (id: string) => act(() => runTextCommand(id));

const DOC = '# Title\n\nalpha one beta\n\nbeta two\n';

describe('Markdown 编辑 / 预览里执行「查找」', () => {
  it('编辑模式:打开查找条并聚焦查找框;焦点在正文的单行选区带入查找框', async () => {
    const { pm, view } = await mount(DOC);
    act(() => {
      pm.focus();
      let at = 0;
      for (let p = 0; p < view.state.doc.content.size; p++) {
        if (view.state.doc.textBetween(p, p + 4) === 'beta') {
          at = p;
          break;
        }
      }
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc as never, at, at + 4)));
    });
    expect(queryFindInput()).toBeNull();
    run('actions.find');
    const input = queryFindInput();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input!.value).toBe('beta');
  });

  it('预览模式同样打开查找条', async () => {
    await mount(DOC, true);
    run('actions.find');
    expect(document.activeElement).toBe(queryFindInput());
  });

  it('「替换」不支持 → 静默(不打开查找条、不抛)', async () => {
    await mount(DOC);
    expect(() => run('editor.action.startFindReplaceAction')).not.toThrow();
    expect(queryFindInput()).toBeNull();
  });

  it('活动 tab 不是这个 Markdown 编辑器(别的组 / 已卸载)→ 静默', async () => {
    const { unmount } = await mount(DOC);
    unmount();
    expect(() => run('actions.find')).not.toThrow();
    expect(queryFindInput()).toBeNull();
  });
});
