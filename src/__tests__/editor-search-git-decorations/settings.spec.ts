// BDD: editor-search-git-decorations / 设置:四项默认值按 VSCode、注册到对应设置页、三语标题 / 描述 / 组名齐全
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import {
  EDITOR_DECORATIONS_BADGES,
  EDITOR_DECORATIONS_COLORS,
  SEARCH_DECORATIONS_BADGES,
  SEARCH_DECORATIONS_COLORS,
} from '../../plugins/settings/core-setting-specs';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

beforeEach(async () => {
  await shutdownCorePlugins();
});
afterEach(async () => {
  await shutdownCorePlugins();
});

describe('编辑器 / 搜索装饰设置', () => {
  it.each([
    [EDITOR_DECORATIONS_COLORS, 'workbench.editor.decorations.colors', 'editor', 'tabs'],
    [EDITOR_DECORATIONS_BADGES, 'workbench.editor.decorations.badges', 'editor', 'tabs'],
    [SEARCH_DECORATIONS_COLORS, 'search.decorations.colors', 'explorer', 'search'],
    [SEARCH_DECORATIONS_BADGES, 'search.decorations.badges', 'explorer', 'search'],
  ] as const)('%#: id / 默认开 / 设置页与分组 / 三语', (spec, id, category, group) => {
    expect(spec).toMatchObject({ id, category, group, type: 'boolean', default: true });
    for (const cat of [en, zh, ko] as Record<string, string>[]) {
      for (const key of [spec.titleKey!, spec.descriptionKey!, spec.groupKey!]) expect(cat[key], key).toBeTruthy();
    }
  });

  it('内置插件启动后四项都已注册(设置页可见)', async () => {
    await bootCorePlugins();
    for (const spec of [EDITOR_DECORATIONS_COLORS, EDITOR_DECORATIONS_BADGES, SEARCH_DECORATIONS_COLORS, SEARCH_DECORATIONS_BADGES]) {
      expect(coApp.settingItems.get(spec.id)?.category, spec.id).toBe(spec.category);
    }
  });
});
