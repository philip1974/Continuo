// BDD: workbench-editor-commands —— 核心插件注册的命令 id / 默认键 / 三语标题。见同目录 README。
import { describe, expect, it } from 'vitest';
import { bootCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import {
  CLOSE_ACTIVE_EDITOR_COMMAND,
  SAVE_COMMAND,
  editorCommandSpecs,
} from '@/panels/Editor/editor-commands';
import {
  WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND,
  WORKBENCH_SAVE_COMMAND,
} from '@/panels/Terminal/terminal-hotkeys';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const IDS = [
  'workbench.action.closeActiveEditor',
  'workbench.action.files.save',
  'workbench.action.nextEditor',
  'workbench.action.previousEditor',
] as const;

function hotkeysOf(platform: 'mac' | 'other'): Record<string, string | undefined> {
  return Object.fromEntries(editorCommandSpecs(platform).map((s) => [s.id, s.hotkey]));
}

describe('工作台编辑器命令注册', () => {
  it('核心插件注册四个命令,默认键按当前平台', () => {
    bootCorePlugins();
    const byId = new Map(coApp.commands.getAll().map((c) => [c.id, c]));
    const expected = hotkeysOf(detectPlatform());
    for (const id of IDS) expect(byId.get(id)?.hotkey).toBe(expected[id]);
  });

  it('⌘W = mod+w、⌘S = mod+s(两平台相同)', () => {
    for (const platform of ['mac', 'other'] as const) {
      const keys = hotkeysOf(platform);
      expect(keys['workbench.action.closeActiveEditor']).toBe('mod+w');
      expect(keys['workbench.action.files.save']).toBe('mod+s');
    }
  });

  it('与终端让出约定的命令 id / 默认键一致(terminal-hotkeys 兜底常量)', () => {
    expect(CLOSE_ACTIVE_EDITOR_COMMAND).toEqual(WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND);
    expect(SAVE_COMMAND).toEqual(WORKBENCH_SAVE_COMMAND);
  });

  it('下一个 / 上一个编辑器:mac ⌥⌘→ / ⌥⌘←,其它 Ctrl+PageDown / Ctrl+PageUp(VSCode 默认)', () => {
    expect(hotkeysOf('mac')['workbench.action.nextEditor']).toBe('mod+alt+right');
    expect(hotkeysOf('mac')['workbench.action.previousEditor']).toBe('mod+alt+left');
    expect(hotkeysOf('other')['workbench.action.nextEditor']).toBe('ctrl+pagedown');
    expect(hotkeysOf('other')['workbench.action.previousEditor']).toBe('ctrl+pageup');
  });

  it('标题 / 分类有三语文案(命令面板可见)', () => {
    for (const spec of editorCommandSpecs('mac')) {
      for (const key of [spec.titleKey, spec.categoryKey]) {
        expect(key).toBeDefined();
        const k = key as keyof typeof en;
        expect(en[k]).toBeTruthy();
        expect(zh[k]).toBeTruthy();
        expect(ko[k]).toBeTruthy();
      }
    }
    expect(zh['commands.file.save.title' as keyof typeof zh]).toBe('保存');
  });
});
