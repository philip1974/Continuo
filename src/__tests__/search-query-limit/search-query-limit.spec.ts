// 边界(E279):搜索 query 长度上限。clampSearchQuery 单一来源,Quick Open / Command Palette setQuery 共用。
// 超长 paste 否则一次性进 fuzzyFilter → O(results×queryLen) 卡死 renderer。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  clampSearchQuery,
  MAX_SEARCH_QUERY_LEN,
  normalizeSearchQuery,
} from '../../lib/search-query';
import { selectVisibleKeybindingCommands } from '../../plugins/settings/KeybindingsTabContent';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';

describe('clampSearchQuery(E279)', () => {
  it('≤ 上限原样', () => {
    expect(clampSearchQuery('hello')).toBe('hello');
    expect(clampSearchQuery('x'.repeat(MAX_SEARCH_QUERY_LEN))).toHaveLength(
      MAX_SEARCH_QUERY_LEN,
    );
  });
  it('超长 → 截断到 MAX_SEARCH_QUERY_LEN', () => {
    expect(clampSearchQuery('x'.repeat(MAX_SEARCH_QUERY_LEN + 5000))).toHaveLength(
      MAX_SEARCH_QUERY_LEN,
    );
  });
});

describe('E279 store setQuery 截断超长 query', () => {
  it('Quick Open setQuery 超长 → 截断', () => {
    useQuickOpenStore.getState().setQuery('q'.repeat(MAX_SEARCH_QUERY_LEN + 1000));
    expect(useQuickOpenStore.getState().query.length).toBe(MAX_SEARCH_QUERY_LEN);
    useQuickOpenStore.getState().setQuery('short');
    expect(useQuickOpenStore.getState().query).toBe('short');
  });

  it('Command Palette setQuery 超长 → 截断', () => {
    useCommandPaletteStore
      .getState()
      .setQuery('c'.repeat(MAX_SEARCH_QUERY_LEN + 1000));
    expect(useCommandPaletteStore.getState().query.length).toBe(
      MAX_SEARCH_QUERY_LEN,
    );
  });
});

// 家族接线守卫:全部搜索/过滤 query 输入入口都必须经 clampSearchQuery(防某入口漏接/回归)。
// E279 修 quick-open/command-palette store;E280 + 家族 sweep 补 terminal 搜索、设置搜索、快捷键搜索。
describe('E279/E280 家族接线守卫:全部搜索输入调用 clampSearchQuery', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  it.each([
    // quick-open / command-palette 两个 store 的 setQuery 已收口到共享 picker 切片(截断行为见上方
    // 两条 store 行为测试)。
    '../../plugins/picker/picker-slice.ts',
    '../../panels/Terminal/TerminalSearchBar.tsx',
    '../../plugins/settings/SettingsPanel.tsx',
    '../../plugins/settings/KeybindingsTabContent.tsx',
    '../../marketplace/MarketplaceTab.tsx',
    '../../marketplace/filter.ts',
  ])('%s 调用 clampSearchQuery(或其上层 normalizeSearchQuery)', (rel) => {
    const src = readFileSync(path.join(dir, rel), 'utf-8');
    expect(src).toMatch(/clampSearchQuery\(|normalizeSearchQuery\(/);
  });
});

// 过滤用 query 统一「截断 + 去首尾空白」:此前命令面板 / 设置 / 市场 trim,Quick Open 与快捷键设置不 trim →
// 输入 " foo" 在 Quick Open(子序列匹配要求路径真有空格)几乎搜不到。终端搜索字面匹配,不纳入。
describe('normalizeSearchQuery:各过滤入口同一规范化', () => {
  it('截断 + 去首尾空白', () => {
    expect(normalizeSearchQuery('  foo \t')).toBe('foo');
    expect(normalizeSearchQuery(' ' + 'x'.repeat(MAX_SEARCH_QUERY_LEN + 10))).toHaveLength(
      MAX_SEARCH_QUERY_LEN - 1,
    );
  });

  it('快捷键设置:带首尾空格的 query 与无空格结果相同', () => {
    const cmd = (id: string, title: string) => ({
      cmd: { id, title, hotkey: 'mod+k' },
      displayTitle: title,
      displayCategory: '',
      effectiveHotkey: 'mod+k',
      hotkeyParts: [],
      isOverridden: false,
      searchHaystack: title.toLowerCase(),
    });
    const list = [cmd('a', 'Open File'), cmd('b', 'Close Tab')] as never;
    expect(selectVisibleKeybindingCommands(list, '  open ').map((d) => d.cmd.id)).toEqual(['a']);
  });

  it.each([
    '../../plugins/command-palette/CommandPalette.tsx',
    '../../plugins/quick-open/QuickOpenModal.tsx',
    '../../plugins/settings/SettingsPanel.tsx',
    '../../plugins/settings/KeybindingsTabContent.tsx',
    '../../marketplace/filter.ts',
  ])('%s 过滤前经 normalizeSearchQuery', (rel) => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf-8');
    expect(src).toContain('normalizeSearchQuery(');
  });
});
