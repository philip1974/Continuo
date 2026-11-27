// @vitest-environment jsdom
// BDD: Markdown Edit 模式的 Crepe 浮层(斜杠菜单 / 选区浮动工具条 / 链接输入框)文案随应用语言显示。
// Crepe 7.23 默认全英文,只能经 featureConfigs 传入;此处钉住每一项都接到 catalog,且 zh / ko 下没有残留的
// Crepe 英文默认值。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { getLocale, notifyLocaleChange, setLocale, t } from '../../i18n';
import type { Locale } from '../../i18n';

type Configs = Record<string, Record<string, unknown>>;

const harness = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: {
    CodeMirror: 'CodeMirror',
    ListItem: 'ListItem',
    LinkTooltip: 'LinkTooltip',
    Cursor: 'Cursor',
    ImageBlock: 'ImageBlock',
    BlockEdit: 'BlockEdit',
    Toolbar: 'Toolbar',
    Placeholder: 'Placeholder',
    Table: 'Table',
    Latex: 'Latex',
  },
  Crepe: vi.fn().mockImplementation((options: unknown) => {
    harness.options.push(options);
    return { setReadonly: vi.fn(), editor: { config: () => {}, use: () => {}, remove: async () => {} }, on: vi.fn(), create: async () => ({}), destroy: async () => {} };
  }),
}));

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function lastConfigs(): Configs {
  const o = harness.options[harness.options.length - 1] as { featureConfigs: Configs };
  return o.featureConfigs;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 期望:Crepe 配置路径 → catalog key(启用的特性里所有会显示的英文默认文案)。 */
const EXPECTED: ReadonlyArray<readonly [feature: string, path: string, key: Parameters<typeof t>[0], crepeDefault: string]> = [
  ['BlockEdit', 'textGroup.label', 'panels.editor.md.slash.textGroup', 'Text'],
  ['BlockEdit', 'textGroup.text.label', 'panels.editor.md.slash.text', 'Text'],
  ['BlockEdit', 'textGroup.h1.label', 'panels.editor.md.slash.h1', 'Heading 1'],
  ['BlockEdit', 'textGroup.h2.label', 'panels.editor.md.slash.h2', 'Heading 2'],
  ['BlockEdit', 'textGroup.h3.label', 'panels.editor.md.slash.h3', 'Heading 3'],
  ['BlockEdit', 'textGroup.h4.label', 'panels.editor.md.slash.h4', 'Heading 4'],
  ['BlockEdit', 'textGroup.h5.label', 'panels.editor.md.slash.h5', 'Heading 5'],
  ['BlockEdit', 'textGroup.h6.label', 'panels.editor.md.slash.h6', 'Heading 6'],
  ['BlockEdit', 'textGroup.quote.label', 'panels.editor.md.slash.quote', 'Quote'],
  ['BlockEdit', 'textGroup.divider.label', 'panels.editor.md.slash.divider', 'Divider'],
  ['BlockEdit', 'listGroup.label', 'panels.editor.md.slash.listGroup', 'List'],
  ['BlockEdit', 'listGroup.bulletList.label', 'panels.editor.md.slash.bulletList', 'Bullet List'],
  ['BlockEdit', 'listGroup.orderedList.label', 'panels.editor.md.slash.orderedList', 'Ordered List'],
  ['BlockEdit', 'listGroup.taskList.label', 'panels.editor.md.slash.taskList', 'Task List'],
  ['BlockEdit', 'advancedGroup.label', 'panels.editor.md.slash.advancedGroup', 'Advanced'],
  ['BlockEdit', 'advancedGroup.codeBlock.label', 'panels.editor.md.slash.codeBlock', 'Code'],
  ['BlockEdit', 'advancedGroup.table.label', 'panels.editor.md.slash.table', 'Table'],
  ['Toolbar', 'boldLabel', 'panels.editor.md.toolbar.bold', 'Bold'],
  ['Toolbar', 'italicLabel', 'panels.editor.md.toolbar.italic', 'Italic'],
  ['Toolbar', 'strikethroughLabel', 'panels.editor.md.toolbar.strikethrough', 'Strikethrough'],
  ['Toolbar', 'codeLabel', 'panels.editor.md.toolbar.code', 'Inline code'],
  ['Toolbar', 'linkLabel', 'panels.editor.md.toolbar.link', 'Link'],
  ['LinkTooltip', 'inputPlaceholder', 'panels.editor.md.link.placeholder', 'Paste link...'],
];

function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

let original: Locale;
beforeEach(() => {
  harness.options.length = 0;
  original = getLocale();
});
afterEach(() => {
  cleanup();
  act(() => {
    setLocale(original);
    notifyLocaleChange();
  });
});

describe('Markdown Edit 模式浮层文案本地化', () => {
  for (const locale of ['en', 'zh', 'ko'] as const) {
    it(`${locale}:斜杠菜单 / 浮动工具条 / 链接输入框全部取自 catalog`, async () => {
      act(() => {
        setLocale(locale);
        notifyLocaleChange();
      });
      render(<MilkdownEditor tabId="/t.md" defaultValue="# T" />);
      await settle();
      const configs = lastConfigs();
      for (const [feature, path, key, crepeDefault] of EXPECTED) {
        const value = at(configs[feature], path);
        expect(value, `${feature}.${path}`).toBe(t(key));
        if (locale !== 'en') expect(value, `${feature}.${path} 仍是英文`).not.toBe(crepeDefault);
      }
    });
  }

  it('代码块 CodeMirror 的内建文案(⌘F 查找面板等)随界面语言(BDD: editor-find-i18n)', async () => {
    act(() => {
      setLocale('zh');
      notifyLocaleChange();
    });
    render(<MilkdownEditor tabId="/t.md" defaultValue="# T" />);
    await settle();
    const extensions = lastConfigs()['CodeMirror']?.['extensions'] as Extension[] | undefined;
    const state = EditorState.create({ extensions: extensions ?? [] });
    expect(state.phrase('Find')).toBe(t('editor.cm.find'));
    expect(state.phrase('replace all')).toBe(t('editor.cm.replace_all'));
  });

  it('切换语言后编辑器重挂,浮层文案换成新语言', async () => {
    act(() => {
      setLocale('en');
      notifyLocaleChange();
    });
    render(<MilkdownEditor tabId="/t.md" defaultValue="# T" />);
    await settle();
    expect(at(lastConfigs()['Toolbar'], 'boldLabel')).toBe('Bold');
    act(() => {
      setLocale('zh');
      notifyLocaleChange();
    });
    await settle();
    expect(harness.options).toHaveLength(2);
    expect(at(lastConfigs()['Toolbar'], 'boldLabel')).toBe(t('panels.editor.md.toolbar.bold'));
    expect(at(lastConfigs()['BlockEdit'], 'textGroup.h1.label')).toBe(t('panels.editor.md.slash.h1'));
  });
});
