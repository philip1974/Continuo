// @vitest-environment jsdom
// BDD:编辑区(CodeMirror 代码 / Markdown 源码、Milkdown 编辑 / 预览、Markdown 代码块)有可访问名称(WCAG 4.1.2,
// axe aria-input-field-name)。对齐 VSCode:编辑器文本区名称「<文件名>, Editor Group N」→ Continuo「<文件名>，编辑器」三语。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { ThemeContext } from '../../theme/ThemeProvider';
import { getLocale, notifyLocaleChange, setLocale, t, type Locale } from '../../i18n';

const instances = vi.hoisted(() => [] as CrepeType[]);

vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function switchLocale(locale: Locale): void {
  act(() => {
    setLocale(locale);
    notifyLocaleChange();
  });
}

function withTheme(node: React.ReactElement): React.ReactElement {
  return (
    <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>{node}</ThemeContext.Provider>
  );
}

async function waitFor<T>(probe: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = probe();
    if (v) return v;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('等待超时');
}

let original: Locale;
beforeEach(() => {
  original = getLocale();
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  instances.length = 0;
  switchLocale(original);
});

describe('代码编辑器(CodeMirror)可访问名称', () => {
  it('文本区 role=textbox 名称 =「<文件名>，编辑器」(只取 basename)', async () => {
    switchLocale('zh');
    const { container } = render(
      withTheme(<CodeEditor tabId="/repo/src/a.ts" value={'x\n'} fileName="/repo/src/a.ts" />),
    );
    await act(async () => {});
    const content = container.querySelector('.cm-content')!;
    expect(content.getAttribute('role')).toBe('textbox');
    expect(content.getAttribute('aria-label')).toBe(t('editor.aria.content', { name: 'a.ts' }));
    expect(content.getAttribute('aria-label')).toBe('a.ts，编辑器');
  });

  it('Markdown 源码模式(forceLanguage=markdown)同样有名称', async () => {
    switchLocale('en');
    const { container } = render(
      withTheme(<CodeEditor tabId="/r/README.md" value={'# T\n'} fileName="/r/README.md" forceLanguage="markdown" />),
    );
    await act(async () => {});
    expect(container.querySelector('.cm-content')!.getAttribute('aria-label')).toBe('README.md, Editor');
  });

  it('切换界面语言 / 文件名变化:同一 EditorView 内更新名称(不重建编辑器)', async () => {
    switchLocale('en');
    const { container, rerender } = render(
      withTheme(<CodeEditor tabId="/r/a.ts" value={'x\n'} fileName="/r/a.ts" />),
    );
    await act(async () => {});
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    switchLocale('ko');
    await act(async () => {});
    expect(EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)).toBe(view);
    expect(view.contentDOM.getAttribute('aria-label')).toBe(t('editor.aria.content', { name: 'a.ts' }));
    expect(view.contentDOM.getAttribute('aria-label')).not.toMatch(/Editor$/);
    rerender(withTheme(<CodeEditor tabId="/r/a.ts" value={'x\n'} fileName="/r/b.ts" />));
    await act(async () => {});
    expect(view.contentDOM.getAttribute('aria-label')).toBe(t('editor.aria.content', { name: 'b.ts' }));
  });

  it('无文件名时退回「编辑器」,不出现空名称', async () => {
    switchLocale('zh');
    const { container } = render(withTheme(<CodeEditor tabId="x" value="" />));
    await act(async () => {});
    expect(container.querySelector('.cm-content')!.getAttribute('aria-label')).toBe(t('panels.editor.title'));
  });
});

describe('Markdown 编辑器(Milkdown)可访问名称', () => {
  it('编辑 / 预览区 .ProseMirror 名称 =「<文件名>，编辑器」;代码块内嵌 CodeMirror 名称 =「代码块」', async () => {
    switchLocale('zh');
    const { container } = render(
      <MilkdownEditor tabId="/r/doc.md" fileName="/r/doc.md" defaultValue={'# T\n\n```js\nconst a = 1;\n```\n'} />,
    );
    const pm = await waitFor(() => container.querySelector('.ProseMirror'));
    expect(pm.getAttribute('aria-label')).toBe('doc.md，编辑器');
    const block = await waitFor(() => container.querySelector('.milkdown .cm-content'));
    expect(block.getAttribute('aria-label')).toBe(t('editor.aria.code_block'));
    expect(block.getAttribute('aria-label')).toBe('代码块');
  });

  it('只读预览同样有名称;切换界面语言(随 locale 重挂)后名称换成新语言', async () => {
    switchLocale('zh');
    const { container } = render(<MilkdownEditor tabId="/r/doc.md" fileName="/r/doc.md" readonly defaultValue="# T" />);
    await waitFor(() => container.querySelector('.ProseMirror[aria-label="doc.md，编辑器"]'));
    switchLocale('en');
    const pm = await waitFor(() => container.querySelector('.ProseMirror[aria-label="doc.md, Editor"]'));
    expect(pm).not.toBeNull();
  });

  it('三语文案', async () => {
    const { en } = await import('../../../electron/shared/i18n-locales/en');
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    expect(en['editor.aria.content']).toBe('{name}, Editor');
    expect(zh['editor.aria.content']).toBe('{name}，编辑器');
    expect(ko['editor.aria.content']).toBe('{name}, 편집기');
    expect([en, zh, ko].map((d) => d['editor.aria.code_block'])).toEqual(['Code block', '代码块', '코드 블록']);
  });
});
