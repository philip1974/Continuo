// @vitest-environment jsdom
// BDD: font-settings —— editor.fontFamily / editor.lineHeight / terminal.integrated.fontFamily / terminal.integrated.lineHeight
// 的设置项、取值规则(对齐 VSCode)与编辑器侧生效方式。终端侧见 terminal-font-settings.spec.tsx。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorView } from '@codemirror/view';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import {
  DEFAULT_EDITOR_FONT_FAMILY,
  EDITOR_FONT_FAMILY,
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  TERMINAL_FONT_FAMILY,
  TERMINAL_LINE_HEIGHT,
} from '@/plugins/settings/core-setting-specs';
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  resolveEditorFontFamily,
  resolveEditorLineHeightPx,
  resolveTerminalFontFamily,
  resolveTerminalLineHeight,
} from '@/plugins/settings/font-settings';
import {
  EDITOR_FONT_FAMILY_VAR,
  EDITOR_LINE_HEIGHT_VAR,
  EditorFontFromSettings,
} from '@/plugins/settings/EditorFontFromSettings';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { coerceSettingValue } from '@/plugins/registries/SettingItemRegistry';
import EditorTabPlugin from '@/core-plugins/EditorTabPlugin';
import TerminalTabPlugin from '@/core-plugins/TerminalTabPlugin';
import { CodeEditor } from '@/panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const SPECS = [EDITOR_FONT_FAMILY, EDITOR_LINE_HEIGHT, TERMINAL_FONT_FAMILY, TERMINAL_LINE_HEIGHT];
const set = (id: string, v: string | number) => act(() => useSettingsValuesStore.getState().setValue(id, v));
const htmlVar = (name: string) => document.documentElement.style.getPropertyValue(name);

function resetAll(): void {
  for (const s of [...SPECS, EDITOR_FONT_SIZE]) useSettingsValuesStore.getState().reset(s.id);
}
beforeEach(resetAll);
afterEach(() => {
  cleanup();
  resetAll();
  document.documentElement.removeAttribute('style');
});

/** 用假 app 跑插件 onload,收集注册的设置项 id。 */
function registeredSettingIds(Cls: typeof EditorTabPlugin | typeof TerminalTabPlugin): string[] {
  const ids: string[] = [];
  const plugin = new Cls({} as never, { id: 'x', name: 'x', version: '1' });
  Object.assign(plugin, {
    addSettingTab: () => {},
    addSettingItem: (s: { id: string }) => ids.push(s.id),
  });
  plugin.onload();
  return ids;
}

describe('设置项', () => {
  it('id 同 VSCode;编辑器 / 终端页各自注册,排在字号旁;三语标题与说明', () => {
    expect(SPECS.map((s) => s.id)).toEqual([
      'editor.fontFamily',
      'editor.lineHeight',
      'terminal.integrated.fontFamily',
      'terminal.integrated.lineHeight',
    ]);
    expect(registeredSettingIds(EditorTabPlugin).slice(0, 3)).toEqual(['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight']);
    expect(registeredSettingIds(TerminalTabPlugin).slice(0, 3)).toEqual([
      'terminal.integrated.fontFamily',
      'terminal.fontSize',
      'terminal.integrated.lineHeight',
    ]);
    for (const s of SPECS) {
      for (const locale of [en, zh, ko]) {
        expect(locale[s.titleKey as keyof typeof en]).toBeTruthy();
        expect(locale[s.descriptionKey as keyof typeof en]).toBeTruthy();
      }
    }
  });

  it('默认值:编辑器字体 = 设计 token --wm-font-mono;编辑器行高 0(自动);终端字体空(跟随编辑器);终端行高 1', () => {
    const tokens = readFileSync(resolve(__dirname, '../../styles/design-tokens.css'), 'utf8');
    const mono = /--wm-font-mono:\s*([^;]+);/.exec(tokens)?.[1]?.trim();
    expect(EDITOR_FONT_FAMILY.default).toBe(mono);
    expect(DEFAULT_EDITOR_FONT_FAMILY).toBe(mono);
    expect([EDITOR_FONT_FAMILY.type, TERMINAL_FONT_FAMILY.type]).toEqual(['text', 'text']);
    expect(EDITOR_LINE_HEIGHT.default).toBe(0);
    expect(TERMINAL_FONT_FAMILY.default).toBe('');
    expect(TERMINAL_LINE_HEIGHT.default).toBe(1);
  });

  it('越界行高经设置读端夹取:编辑器 [0, 150],终端 [1, 10]', () => {
    expect(coerceSettingValue(EDITOR_LINE_HEIGHT, -3)).toBe(0);
    expect(coerceSettingValue(EDITOR_LINE_HEIGHT, 999)).toBe(150);
    expect(coerceSettingValue(TERMINAL_LINE_HEIGHT, 0.5)).toBe(1);
    expect(coerceSettingValue(TERMINAL_LINE_HEIGHT, 99)).toBe(10);
  });
});

describe('取值规则', () => {
  it('编辑器字体:去首尾空白与结尾逗号;空 / 全空白 / 非字符串 → 默认', () => {
    expect(resolveEditorFontFamily('  "Fira Code", Menlo, ')).toBe('"Fira Code", Menlo');
    expect(resolveEditorFontFamily('')).toBe(DEFAULT_EDITOR_FONT_FAMILY);
    expect(resolveEditorFontFamily('   ')).toBe(DEFAULT_EDITOR_FONT_FAMILY);
    expect(resolveEditorFontFamily(42)).toBe(DEFAULT_EDITOR_FONT_FAMILY);
  });

  it('编辑器行高(VSCode fontInfo):0 自动;<8 为字号倍数;≥8 为像素;取整且不低于 8;非法值按 0 / 夹到 150', () => {
    expect(resolveEditorLineHeightPx(0, 13)).toBeNull();
    expect(resolveEditorLineHeightPx(1.5, 13)).toBe(20);
    expect(resolveEditorLineHeightPx(2, 14)).toBe(28);
    expect(resolveEditorLineHeightPx(22, 13)).toBe(22);
    expect(resolveEditorLineHeightPx(22.4, 13)).toBe(22);
    expect(resolveEditorLineHeightPx(0.2, 13)).toBe(8);
    expect(resolveEditorLineHeightPx(-4, 13)).toBeNull();
    expect(resolveEditorLineHeightPx(Number.NaN, 13)).toBeNull();
    expect(resolveEditorLineHeightPx(1000, 13)).toBe(150);
  });

  it('终端字体:自己的值优先;空 → 跟随编辑器字体;编辑器也是默认 → 终端自带 Nerd Font 链;用户字体后接符号回退与 monospace', () => {
    expect(resolveTerminalFontFamily('', '')).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(resolveTerminalFontFamily('  ', DEFAULT_EDITOR_FONT_FAMILY)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(resolveTerminalFontFamily('', 'Fira Code')).toMatch(/^Fira Code, .*monospace$/);
    expect(resolveTerminalFontFamily('Hack', 'Fira Code')).toMatch(/^Hack, .*"Symbols Nerd Font Mono".*monospace$/);
    expect(DEFAULT_TERMINAL_FONT_FAMILY.startsWith('"MesloLGS NF"')).toBe(true);
  });

  it('终端行高:倍数,0 / 非法 → 1,夹到 [1, 10]', () => {
    expect(resolveTerminalLineHeight(1.2)).toBe(1.2);
    expect(resolveTerminalLineHeight(0)).toBe(1);
    expect(resolveTerminalLineHeight(Number.NaN)).toBe(1);
    expect(resolveTerminalLineHeight('x')).toBe(1);
    expect(resolveTerminalLineHeight(0.5)).toBe(1);
    expect(resolveTerminalLineHeight(42)).toBe(10);
  });
});

describe('编辑器侧生效', () => {
  it('EditorFontFromSettings:把字体 / 行高写到 <html> 的 CSS 变量,改设置即时更新;行高自动 → 移除变量;空字体 → 默认', () => {
    render(<EditorFontFromSettings />);
    expect(htmlVar(EDITOR_FONT_FAMILY_VAR)).toBe(DEFAULT_EDITOR_FONT_FAMILY);
    expect(htmlVar(EDITOR_LINE_HEIGHT_VAR)).toBe('');

    set(EDITOR_FONT_FAMILY.id, 'Fira Code');
    set(EDITOR_LINE_HEIGHT.id, 2);
    set(EDITOR_FONT_SIZE.id, 15);
    expect(htmlVar(EDITOR_FONT_FAMILY_VAR)).toBe('Fira Code');
    expect(htmlVar(EDITOR_LINE_HEIGHT_VAR)).toBe('30px');

    set(EDITOR_FONT_FAMILY.id, '   ');
    set(EDITOR_LINE_HEIGHT.id, 0);
    expect(htmlVar(EDITOR_FONT_FAMILY_VAR)).toBe(DEFAULT_EDITOR_FONT_FAMILY);
    expect(htmlVar(EDITOR_LINE_HEIGHT_VAR)).toBe('');
  });

  it('代码编辑器(含 Markdown 源码模式)字体 / 行高取这两个变量;改设置后 CodeMirror 重新测量', () => {
    const A = '/w/a.ts';
    useEditorStore.setState({ tabs: [createTab(A, 'x')], activeTabId: A, viewRefs: new Map() });
    const measure = vi.spyOn(EditorView.prototype, 'requestMeasure').mockImplementation(() => {});
    render(<CodeEditor tabId={A} value="x" fileName="a.ts" onChange={() => {}} />);
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(css).toMatch(/\.cm-scroller[^}]*font-family:\s*var\(--wm-editor-font-family, var\(--wm-font-mono\)\)/);
    expect(css).toMatch(/\.cm-scroller[^}]*line-height:\s*var\(--wm-editor-line-height, 1\.4\)/);
    measure.mockClear();
    set(EDITOR_FONT_FAMILY.id, 'Fira Code');
    expect(measure).toHaveBeenCalled();
    measure.mockClear();
    set(EDITOR_LINE_HEIGHT.id, 24);
    expect(measure).toHaveBeenCalled();
    measure.mockRestore();
  });
});
