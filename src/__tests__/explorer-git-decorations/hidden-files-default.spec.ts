// @vitest-environment jsdom
// BDD: explorer-git-decorations / 点文件默认可见:showHiddenFiles 默认 true、排除集对齐 VSCode files.exclude、已存的显式 false 保留
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  EXPLORER_DECORATIONS_BADGES,
  EXPLORER_DECORATIONS_COLORS,
  EXPLORER_SHOW_HIDDEN_FILES,
} from '../../plugins/settings/core-setting-specs';
import { SETTINGS_VALUES_STORAGE_KEY } from '../../plugins/settings/storage-key';
import { LIST_DIR_DEFAULT_EXCLUDE } from '../../../electron/shared/fs-limits';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

describe('explorer.showHiddenFiles', () => {
  it('默认显示点文件(VSCode 不隐藏 .gitignore / .env / .github)', () => {
    expect(EXPLORER_SHOW_HIDDEN_FILES.default).toBe(true);
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  async function readWithStored(stored: Record<string, unknown> | null): Promise<boolean> {
    if (stored) localStorage.setItem(SETTINGS_VALUES_STORAGE_KEY, JSON.stringify(stored));
    vi.resetModules();
    const { coApp } = await import('../../plugins/co-app');
    const { useSettingValue } = await import('../../plugins/settings/values-store');
    const d = coApp.settingItems.register(EXPLORER_SHOW_HIDDEN_FILES);
    try {
      const { result } = renderHook(() =>
        useSettingValue(EXPLORER_SHOW_HIDDEN_FILES.id, EXPLORER_SHOW_HIDDEN_FILES.default),
      );
      return result.current;
    } finally {
      d.dispose();
    }
  }

  it('未设置过 → true;之前显式设为 false 的用户保留 false(只存 override,不做迁移覆盖)', async () => {
    expect(await readWithStored(null)).toBe(true);
    expect(await readWithStored({ 'explorer.showHiddenFiles': false })).toBe(false);
  });
});

describe('固定排除集', () => {
  it('= VSCode files.exclude 默认(.git .svn .hg CVS .DS_Store Thumbs.db)+ 既有 node_modules', () => {
    expect([...LIST_DIR_DEFAULT_EXCLUDE].sort()).toEqual(
      ['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db', 'node_modules'].sort(),
    );
  });
});

describe('装饰设置', () => {
  it('explorer.decorations.colors / badges 默认开,三语标题与说明', () => {
    for (const spec of [EXPLORER_DECORATIONS_COLORS, EXPLORER_DECORATIONS_BADGES]) {
      expect(spec.default).toBe(true);
      expect(spec.category).toBe('explorer');
      for (const cat of [en, zh, ko] as Record<string, string>[]) {
        expect(cat[spec.titleKey!]).toBeTruthy();
        expect(cat[spec.descriptionKey!]).toBeTruthy();
      }
    }
    expect(EXPLORER_DECORATIONS_COLORS.id).toBe('explorer.decorations.colors');
    expect(EXPLORER_DECORATIONS_BADGES.id).toBe('explorer.decorations.badges');
  });
});
