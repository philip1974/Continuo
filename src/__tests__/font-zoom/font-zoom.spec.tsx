// @vitest-environment jsdom
// BDD: font-zoom —— 编辑器临时字体缩放、终端字号命令、滚轮缩放。见同目录 README。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coApp } from '@/plugins/co-app';
import {
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  EDITOR_MOUSE_WHEEL_ZOOM,
  TERMINAL_FONT_SIZE,
  TERMINAL_MOUSE_WHEEL_ZOOM,
} from '@/plugins/settings/core-setting-specs';
import { getStoredSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import {
  editorFontZoomCommandSpecs,
  getEditorZoomLevel,
  setEditorZoomLevel,
  useEditorFontSize,
  useEditorFontStyle,
} from '@/panels/Editor/editor-font-zoom';
import { terminalFontZoomCommandSpecs } from '@/panels/Terminal/terminal-font-zoom';
import { attachMouseWheelZoom, hasMouseWheelZoomModifiers } from '@/lib/mouse-wheel-zoom';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const editorCmds = editorFontZoomCommandSpecs();
const terminalCmds = terminalFontZoomCommandSpecs();
const run = (specs: CommandSpec[], id: string) => specs.find((c) => c.id === id)!.fn();
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

beforeAll(() => {
  for (const s of [EDITOR_FONT_SIZE, EDITOR_LINE_HEIGHT, TERMINAL_FONT_SIZE, EDITOR_MOUSE_WHEEL_ZOOM, TERMINAL_MOUSE_WHEEL_ZOOM]) {
    if (!coApp.settingItems.get(s.id)) coApp.settingItems.register(s);
  }
});
beforeEach(() => {
  useSettingsValuesStore.setState({ values: {} });
  setEditorZoomLevel(0);
});

describe('编辑器字体缩放(临时,不写设置)', () => {
  it('三条命令:VSCode 同 id,无默认键、无分类,三语标题;EditorPlugin 注册', () => {
    expect(editorCmds.map((c) => c.id)).toEqual(['editor.action.fontZoomIn', 'editor.action.fontZoomOut', 'editor.action.fontZoomReset']);
    for (const c of editorCmds) {
      expect(c.hotkey, c.id).toBeUndefined();
      expect(c.category, c.id).toBeUndefined();
      for (const cat of [en, zh, ko] as Array<Record<string, string>>) expect(cat[c.titleKey!], c.id).toEqual(expect.any(String));
    }
    expect((zh as Record<string, string>)['commands.editor.font_zoom_in.title']).toBe('放大编辑器字体');
    expect(src('src/core-plugins/EditorPlugin.ts')).toContain('editorFontZoomCommandSpecs()');
  });

  it('放大 / 缩小 ±1 级,夹在 [-5, 20],重置回 0;不改 editor.fontSize', () => {
    run(editorCmds, 'editor.action.fontZoomIn');
    run(editorCmds, 'editor.action.fontZoomIn');
    expect(getEditorZoomLevel()).toBe(2);
    run(editorCmds, 'editor.action.fontZoomOut');
    expect(getEditorZoomLevel()).toBe(1);
    setEditorZoomLevel(20);
    run(editorCmds, 'editor.action.fontZoomIn');
    expect(getEditorZoomLevel()).toBe(20);
    setEditorZoomLevel(-5);
    run(editorCmds, 'editor.action.fontZoomOut');
    expect(getEditorZoomLevel()).toBe(-5);
    run(editorCmds, 'editor.action.fontZoomReset');
    expect(getEditorZoomLevel()).toBe(0);
    expect(getStoredSettingValue(EDITOR_FONT_SIZE.id)).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('生效字号 = 设置 × (1 + 0.1 × 级别);设置了行高时行高同样放大', () => {
    const { result } = renderHook(() => ({ size: useEditorFontSize(), style: useEditorFontStyle() }));
    expect(result.current.size).toBe(13);
    act(() => run(editorCmds, 'editor.action.fontZoomIn'));
    expect(result.current.size).toBe(14.3);
    expect(result.current.style).toEqual({ fontSize: '14.3px' });
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_LINE_HEIGHT.id, 20));
    expect(result.current.style).toEqual({ fontSize: '14.3px', '--wm-editor-line-height': '22px' });
    act(() => run(editorCmds, 'editor.action.fontZoomReset'));
    expect(result.current.style).toEqual({ fontSize: '13px' });
  });

  it('代码编辑器、Markdown 编辑 / 源码、冲突比较都用缩放后的字号与滚轮缩放', () => {
    for (const f of ['CodeEditor.tsx', 'MilkdownEditor.tsx', 'ConflictDiffPanel.tsx']) {
      const s = src(`src/panels/Editor/${f}`);
      expect(s, f).toContain('useEditorFontStyle()');
      expect(s, f).toContain('useEditorMouseWheelZoom(');
      expect(s, f).not.toContain('useSettingValue(EDITOR_FONT_SIZE.id');
    }
  });
});

describe('终端字体缩放(改设置)', () => {
  it('三条命令:分类「终端」,无默认键;TerminalPlugin 注册', () => {
    expect(terminalCmds.map((c) => c.id)).toEqual([
      'workbench.action.terminal.fontZoomIn',
      'workbench.action.terminal.fontZoomOut',
      'workbench.action.terminal.fontZoomReset',
    ]);
    for (const c of terminalCmds) {
      expect(c).toMatchObject({ categoryKey: 'commands.terminal.category' });
      expect(c.hotkey).toBeUndefined();
      expect((ko as Record<string, string>)[c.titleKey!]).toEqual(expect.any(String));
    }
    expect(src('src/core-plugins/TerminalPlugin.ts')).toContain('terminalFontZoomCommandSpecs()');
  });

  it('±1 写 terminal.integrated.fontSize,夹在设置范围 [10, 24];重置删掉覆盖', () => {
    run(terminalCmds, 'workbench.action.terminal.fontZoomIn');
    expect(getStoredSettingValue(TERMINAL_FONT_SIZE.id)).toBe(14);
    useSettingsValuesStore.getState().setValue(TERMINAL_FONT_SIZE.id, 24);
    run(terminalCmds, 'workbench.action.terminal.fontZoomIn');
    expect(getStoredSettingValue(TERMINAL_FONT_SIZE.id)).toBe(24);
    useSettingsValuesStore.getState().setValue(TERMINAL_FONT_SIZE.id, 10);
    run(terminalCmds, 'workbench.action.terminal.fontZoomOut');
    expect(getStoredSettingValue(TERMINAL_FONT_SIZE.id)).toBe(10);
    run(terminalCmds, 'workbench.action.terminal.fontZoomReset');
    expect(getStoredSettingValue(TERMINAL_FONT_SIZE.id)).toBeUndefined();
  });
});

describe('滚轮缩放', () => {
  const wheel = (init: WheelEventInit) => new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });

  it('设置默认关(VSCode 同),由编辑器 / 终端设置页注册,三语文案', () => {
    expect(EDITOR_MOUSE_WHEEL_ZOOM).toMatchObject({ id: 'editor.mouseWheelZoom', default: false, category: 'editor' });
    expect(TERMINAL_MOUSE_WHEEL_ZOOM).toMatchObject({ id: 'terminal.integrated.mouseWheelZoom', default: false, category: 'terminal' });
    expect(src('src/core-plugins/EditorTabPlugin.ts')).toContain('this.addSettingItem(EDITOR_MOUSE_WHEEL_ZOOM)');
    expect(src('src/core-plugins/TerminalTabPlugin.ts')).toContain('this.addSettingItem(TERMINAL_MOUSE_WHEEL_ZOOM)');
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      expect(cat[EDITOR_MOUSE_WHEEL_ZOOM.descriptionKey!]).toEqual(expect.any(String));
      expect(cat[TERMINAL_MOUSE_WHEEL_ZOOM.titleKey!]).toEqual(expect.any(String));
    }
    expect(src('src/panels/Terminal/useTerminal.ts')).toContain('useTerminalMouseWheelZoom(containerRef)');
  });

  it('修饰键:mac ⌘ 或 ⌃(捏合)、其它平台只 Ctrl;带 ⇧ / ⌥ 不算', () => {
    expect(hasMouseWheelZoomModifiers({ metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, 'mac')).toBe(true);
    expect(hasMouseWheelZoomModifiers({ metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, 'mac')).toBe(true);
    expect(hasMouseWheelZoomModifiers({ metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }, 'mac')).toBe(false);
    expect(hasMouseWheelZoomModifiers({ metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, 'other')).toBe(false);
    expect(hasMouseWheelZoomModifiers({ metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, 'other')).toBe(true);
  });

  it('向上一格放大、向下一格缩小并阻止滚动;不按修饰键照常滚动;小增量累计满一格', () => {
    const el = document.createElement('div');
    const steps: number[] = [];
    const detach = attachMouseWheelZoom(el, (d) => steps.push(d), 'mac');
    const up = wheel({ deltaY: -100, metaKey: true });
    el.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    el.dispatchEvent(wheel({ deltaY: 100, metaKey: true }));
    const plain = wheel({ deltaY: -100 });
    el.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    for (let i = 0; i < 3; i++) el.dispatchEvent(wheel({ deltaY: -20, ctrlKey: true }));
    expect(steps).toEqual([1, -1, 1]);
    detach();
    el.dispatchEvent(wheel({ deltaY: -100, metaKey: true }));
    expect(steps).toEqual([1, -1, 1]);
  });
});
