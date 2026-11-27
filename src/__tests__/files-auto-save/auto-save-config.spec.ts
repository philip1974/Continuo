// @vitest-environment jsdom
// BDD: files-auto-save 第 1 / 4 条 —— files.autoSave / files.autoSaveDelay 设置项、每个文件的生效模式(Markdown 覆盖保持默认
// 行为不变)、切换自动保存命令(VSCode toggleAutoSave 语义)。见同目录 README。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { coerceSettingValue } from '@/plugins/registries/SettingItemRegistry';
import {
  AUTO_SAVE_DELAY_MS,
  AUTO_SAVE_MARKDOWN_ENABLED,
  FILES_AUTO_SAVE,
  FILES_AUTO_SAVE_DELAY,
} from '@/plugins/settings/core-setting-specs';
import {
  DEFAULT_AUTO_SAVE_SETTINGS,
  resolveAutoSave,
  toggleAutoSave,
  TOGGLE_AUTO_SAVE_COMMAND_ID,
  type AutoSaveSettings,
} from '@/panels/Editor/auto-save-config';
import { isAutoSaveEnabled } from '@/panels/Editor/useAutoSave';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

beforeAll(() => bootCorePlugins());
beforeEach(() => useSettingsValuesStore.setState({ values: {} }));

const settings = (over: Partial<AutoSaveSettings>): AutoSaveSettings => ({ ...DEFAULT_AUTO_SAVE_SETTINGS, ...over });

describe('设置项', () => {
  it('files.autoSave:select,默认 off,取值 off / afterDelay / onFocusChange / onWindowChange,在编辑器「自动保存」组', () => {
    const spec = coApp.settingItems.get('files.autoSave');
    expect(spec).toMatchObject({ type: 'select', default: 'off', category: 'editor', group: 'autosave' });
    expect(spec?.enum?.map((o) => o.value)).toEqual(['off', 'afterDelay', 'onFocusChange', 'onWindowChange']);
  });

  it('files.autoSaveDelay:默认 1000ms,夹取到 100–60000', () => {
    const spec = coApp.settingItems.get('files.autoSaveDelay');
    expect(spec).toMatchObject({ type: 'number', default: 1000, unit: 'ms', group: 'autosave' });
    expect(coerceSettingValue(FILES_AUTO_SAVE_DELAY, 5)).toBe(100);
    expect(coerceSettingValue(FILES_AUTO_SAVE_DELAY, 10_000_000)).toBe(60_000);
  });

  it('Markdown 覆盖沿用既有 id 与默认值(开启、2000ms)', () => {
    expect(coApp.settingItems.get('autoSave.markdown.enabled')).toMatchObject({ type: 'boolean', default: true });
    expect(coApp.settingItems.get('autoSave.delayMs')).toMatchObject({ type: 'number', default: 2000 });
  });

  it('自动保存组内顺序:files.autoSave、files.autoSaveDelay 在 Markdown 两项之前', () => {
    const p = (id: string) => coApp.settingItems.get(id)!.priority ?? 0;
    expect(p(FILES_AUTO_SAVE.id)).toBeLessThan(p(FILES_AUTO_SAVE_DELAY.id));
    expect(p(FILES_AUTO_SAVE_DELAY.id)).toBeLessThan(p(AUTO_SAVE_MARKDOWN_ENABLED.id));
    expect(p(AUTO_SAVE_MARKDOWN_ENABLED.id)).toBeLessThan(p(AUTO_SAVE_DELAY_MS.id));
  });

  it('三语标题 / 描述 / 取值标签齐全;描述写明 Markdown 默认自动保存', () => {
    const keys = [
      FILES_AUTO_SAVE.titleKey,
      FILES_AUTO_SAVE.descriptionKey,
      ...(FILES_AUTO_SAVE.enum ?? []).map((o) => o.labelKey),
      FILES_AUTO_SAVE_DELAY.titleKey,
      FILES_AUTO_SAVE_DELAY.descriptionKey,
    ];
    for (const key of keys) {
      expect(key).toBeTruthy();
      for (const locale of [en, zh, ko]) expect((locale as Record<string, string>)[key!], key).toBeTruthy();
    }
    expect((zh as Record<string, string>)[FILES_AUTO_SAVE.descriptionKey!]).toContain('Markdown');
    expect((en as Record<string, string>)[FILES_AUTO_SAVE.descriptionKey!]).toContain('Markdown');
    expect((ko as Record<string, string>)[FILES_AUTO_SAVE.descriptionKey!]).toContain('Markdown');
  });
});

describe('每个文件的生效模式(resolveAutoSave)', () => {
  it('默认:Markdown 停手 2000ms 自动保存,代码不自动保存(行为不变)', () => {
    expect(resolveAutoSave('/w/README.md', DEFAULT_AUTO_SAVE_SETTINGS)).toEqual({ mode: 'afterDelay', delayMs: 2000 });
    expect(resolveAutoSave('/w/a.MARKDOWN', DEFAULT_AUTO_SAVE_SETTINGS)).toEqual({ mode: 'afterDelay', delayMs: 2000 });
    expect(resolveAutoSave('/w/src/a.ts', DEFAULT_AUTO_SAVE_SETTINGS)).toEqual({ mode: 'off' });
    expect(isAutoSaveEnabled('/w/src/a.ts')).toBe(false);
    expect(isAutoSaveEnabled('/w/README.md')).toBe(true);
  });

  it('无路径 / 无标题文件从不自动保存(含 afterDelay、Markdown)', () => {
    const s = settings({ mode: 'afterDelay' });
    expect(resolveAutoSave(null, s)).toEqual({ mode: 'off' });
    expect(resolveAutoSave('untitled:Untitled-1', s)).toEqual({ mode: 'off' });
    expect(isAutoSaveEnabled('untitled:Untitled-1', s)).toBe(false);
  });

  it('files.autoSave = afterDelay:代码按 files.autoSaveDelay;Markdown 仍按覆盖的延迟', () => {
    const s = settings({ mode: 'afterDelay', delayMs: 700 });
    expect(resolveAutoSave('/w/a.ts', s)).toEqual({ mode: 'afterDelay', delayMs: 700 });
    expect(resolveAutoSave('/w/a.md', s)).toEqual({ mode: 'afterDelay', delayMs: 2000 });
    expect(isAutoSaveEnabled('/w/a.ts', s)).toBe(true);
  });

  it('onFocusChange / onWindowChange 作用于代码文件', () => {
    expect(resolveAutoSave('/w/a.ts', settings({ mode: 'onFocusChange' }))).toEqual({ mode: 'onFocusChange' });
    expect(resolveAutoSave('/w/a.ts', settings({ mode: 'onWindowChange' }))).toEqual({ mode: 'onWindowChange' });
  });

  it('Markdown 覆盖开启时不看 files.autoSave(语言级覆盖优先)', () => {
    expect(resolveAutoSave('/w/a.md', settings({ mode: 'onWindowChange' }))).toEqual({ mode: 'afterDelay', delayMs: 2000 });
  });

  it('Markdown 覆盖关闭:Markdown 跟随 files.autoSave', () => {
    expect(resolveAutoSave('/w/a.md', settings({ markdown: false }))).toEqual({ mode: 'off' });
    expect(resolveAutoSave('/w/a.md', settings({ markdown: false, mode: 'onFocusChange' }))).toEqual({
      mode: 'onFocusChange',
    });
    expect(resolveAutoSave('/w/a.md', settings({ markdown: false, mode: 'afterDelay', delayMs: 300 }))).toEqual({
      mode: 'afterDelay',
      delayMs: 300,
    });
  });
});

describe('切换自动保存(workbench.action.toggleAutoSave)', () => {
  const mode = () => useSettingsValuesStore.getState().values['files.autoSave'] ?? FILES_AUTO_SAVE.default;

  it('off → afterDelay;afterDelay / onFocusChange / onWindowChange → off', () => {
    toggleAutoSave();
    expect(mode()).toBe('afterDelay');
    toggleAutoSave();
    expect(mode()).toBe('off');
    for (const m of ['onFocusChange', 'onWindowChange'] as const) {
      useSettingsValuesStore.getState().setValue('files.autoSave', m);
      toggleAutoSave();
      expect(mode()).toBe('off');
    }
  });

  it('不改 Markdown 覆盖', () => {
    toggleAutoSave();
    expect(useSettingsValuesStore.getState().values['autoSave.markdown.enabled']).toBeUndefined();
  });

  it('命令已注册:分类「文件」,三语标题', () => {
    const spec = coApp.commands.get(TOGGLE_AUTO_SAVE_COMMAND_ID);
    expect(TOGGLE_AUTO_SAVE_COMMAND_ID).toBe('workbench.action.toggleAutoSave');
    expect(spec).toMatchObject({ title: 'Toggle Auto Save', category: 'File', categoryKey: 'commands.file.category' });
    expect(en[spec!.titleKey as keyof typeof en]).toBe('Toggle Auto Save');
    expect(zh[spec!.titleKey as keyof typeof zh]).toBe('切换自动保存');
    expect(ko[spec!.titleKey as keyof typeof ko]).toBe('자동 저장 설정/해제');
    spec!.fn();
    expect(mode()).toBe('afterDelay');
  });
});
