// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import {
  redrawMermaidPreviews,
  renderMermaidPreview,
} from '../../panels/Editor/mermaid-preview';
import { ThemeContext } from '../../theme/ThemeProvider';
import { getLocale, notifyLocaleChange, setLocale, t } from '../../i18n';

interface CrepeOptions {
  defaultValue: string;
  featureConfigs: Record<string, Record<string, unknown>>;
}

const crepeHarness = vi.hoisted(() => ({
  options: [] as unknown[],
}));

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
    crepeHarness.options.push(options);
    return {
      setReadonly: vi.fn(),
      on: vi.fn(),
      create: async () => ({}),
      destroy: async () => {},
    };
  }),
}));

// @milkdown/react 用真实实现:重挂载时序(Provider 里的 editorFactory 何时换成新的)正是被测行为。

vi.mock('../../panels/Editor/mermaid-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../panels/Editor/mermaid-preview')>()),
  redrawMermaidPreviews: vi.fn(),
}));

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function themed(resolved: 'light' | 'dark', defaultValue: string) {
  return (
    <ThemeContext.Provider value={{ mode: resolved, resolved, setMode: () => {} }}>
      <MilkdownEditor defaultValue={defaultValue} />
    </ThemeContext.Provider>
  );
}

function lastOptions(): CrepeOptions {
  return crepeHarness.options[crepeHarness.options.length - 1] as CrepeOptions;
}

beforeEach(() => {
  crepeHarness.options.length = 0;
  vi.mocked(redrawMermaidPreviews).mockClear();
});

afterEach(() => {
  cleanup();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('MilkdownEditor code block wiring', () => {
  it('renders mermaid code blocks through renderMermaidPreview', async () => {
    render(<MilkdownEditor defaultValue="# Title" />);
    await settle();

    expect(lastOptions().featureConfigs['CodeMirror']?.['renderPreview']).toBe(
      renderMermaidPreview,
    );
  });

  it('localizes the code block chrome', async () => {
    render(<MilkdownEditor defaultValue="# Title" />);
    await settle();

    const config = lastOptions().featureConfigs['CodeMirror'] as {
      copyText: string;
      searchPlaceholder: string;
      noResultText: string;
      previewLabel: string;
      previewLoading: string;
      previewToggleText: (previewOnly: boolean) => string;
    };
    expect(config.copyText).toBe(t('panels.editor.codeBlock.copy'));
    expect(config.searchPlaceholder).toBe(
      t('panels.editor.codeBlock.searchLanguage'),
    );
    expect(config.noResultText).toBe(t('panels.editor.codeBlock.noResult'));
    expect(config.previewLabel).toBe(t('panels.editor.codeBlock.previewLabel'));
    expect(config.previewLoading).toBe(
      t('panels.editor.codeBlock.previewLoading'),
    );
    expect(config.previewToggleText(true)).toBe(
      t('panels.editor.codeBlock.previewEdit'),
    );
    expect(config.previewToggleText(false)).toBe(
      t('panels.editor.codeBlock.previewHide'),
    );
  });

  // 主题切换(含跟随系统的自动切换)可能发生在输入途中:不重挂载编辑器,只就地重画图。
  it('keeps the editor and redraws diagrams in place when the app theme changes', async () => {
    const view = render(themed('dark', 'v1'));
    await settle();
    expect(crepeHarness.options).toHaveLength(1);
    expect(redrawMermaidPreviews).not.toHaveBeenCalled();

    view.rerender(themed('light', 'v2'));
    await settle();

    expect(crepeHarness.options).toHaveLength(1);
    expect(redrawMermaidPreviews).toHaveBeenCalledTimes(1);
    expect(vi.mocked(redrawMermaidPreviews).mock.calls[0]![0]).toBe(
      view.container.querySelector('.overflow-auto'),
    );
  });

  // 重挂载必须只建一个新编辑器、且用当前内容:不能先用旧挂载时的内容建一个临时编辑器
  // (它的 listener 仍连着 store,任何挂载期事务都会把陈旧内容写回)。
  it('remounts when the app language changes so the chrome is re-localized', async () => {
    const original = getLocale();
    try {
      const view = render(<MilkdownEditor defaultValue="v1" />);
      await settle();
      view.rerender(<MilkdownEditor defaultValue="v2" />);
      await settle();
      const before = (
        lastOptions().featureConfigs['CodeMirror'] as { copyText: string }
      ).copyText;

      act(() => {
        setLocale(original === 'en' ? 'zh' : 'en');
        notifyLocaleChange();
      });
      await settle();

      expect(crepeHarness.options).toHaveLength(2);
      expect(lastOptions().defaultValue).toBe('v2');
      const after = (
        lastOptions().featureConfigs['CodeMirror'] as { copyText: string }
      ).copyText;
      expect(after).not.toBe(before);
      expect(after).toBe(t('panels.editor.codeBlock.copy'));
    } finally {
      act(() => {
        setLocale(original);
        notifyLocaleChange();
      });
    }
  });
});
