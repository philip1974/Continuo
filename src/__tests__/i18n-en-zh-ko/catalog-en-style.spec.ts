// @vitest-environment node
// en 文案引号一致(对齐 VSCode 英文版):引用文件名 / 命令名 / 搜索词等一律用弯引号 “…”,不混用 '…' / "…"。
// 词内撇号(Don't / window's)保持直撇号;反引号代码段内按代码原样。
// 术语:插件市场统一叫 Marketplace(对齐 VSCode「Extensions Marketplace」/「Marketplace」;catalog 内原 Marketplace
// 多处 vs Plugin Market 仅设置页签一处),不单独称 Market。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../../../electron/shared/i18n-locales/en';

/** 去掉反引号代码段(其内引号按代码原样)。 */
const stripCode = (value: string): string => value.replace(/`[^`]*`/g, '');

const EN_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['直引号包裹的占位符(用 “{x}”)', /'\{[^}]+\}'|"\{[^}]+\}"/],
  ['直双引号(用 “…”)', /"/],
  // 词首前无字母的 ' 开引号、后无字母的 ' 闭引号;排除词内撇号与复数所有格(files' )
  ['直单引号当引号用(用 “…”)', /(^|[^A-Za-z])'(?=\S)|(?<=[A-Za-z0-9.])'(?=[\s.,;:!?)]|$)(?<!s')/],
];

describe('en catalog 引号风格', () => {
  for (const [rule, re] of EN_RULES) {
    it(`en 不出现${rule}`, () => {
      const hits = Object.entries(en)
        .filter(([, v]) => re.test(stripCode(v)))
        .map(([k, v]) => `${k}: ${v}`);
      expect(hits).toEqual([]);
    });
  }

  it('弯引号成对出现', () => {
    const hits = Object.entries(en)
      .filter(([, v]) => (v.match(/“/g) ?? []).length !== (v.match(/”/g) ?? []).length)
      .map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
  });
});

describe('en 术语:插件市场统一 Marketplace', () => {
  const MARKET_ALONE = /\bMarket\b/i;

  it('en catalog 不出现单独的 Market(如 Plugin Market)', () => {
    const hits = Object.entries(en)
      .filter(([, v]) => MARKET_ALONE.test(stripCode(v)))
      .map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
  });

  // Continuo 的可安装单元叫 plugin(侧栏 / 设置 / 市场全称 Plugins),en 不能混称 extension(Git 安装按钮曾写
  // 「Install extension」、占位 extension-repo.git)。豁免:「file extension(s)」指文件扩展名,不是插件。
  it('en catalog 不用 extension 指代插件(file extension 除外)', () => {
    const hits = Object.entries(en)
      .filter(([, v]) => /\bextensions?\b/i.test(stripCode(v).replace(/\bfile extensions?\b/gi, '')))
      .map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
  });

  it('Git URL 安装输入框占位用 plugin-repo.git', () => {
    const src = readFileSync(join(process.cwd(), 'src/marketplace/MarketplaceTab.tsx'), 'utf8');
    expect(src).not.toMatch(/extension-repo/);
    expect(src).toMatch(/placeholder="https:\/\/github\.com\/user\/plugin-repo\.git"/);
  });

  it('市场设置页签标题(catalog 与 titleKey 缺失时的回退 title)为 Marketplace', () => {
    expect(en['settings.plugins.market_title']).toBe('Marketplace');
    const src = readFileSync(join(process.cwd(), 'src/core-plugins/PluginsTabPlugin.ts'), 'utf8');
    expect(src).toMatch(/title: 'Marketplace',\s*titleKey: 'settings\.plugins\.market_title'/);
  });
});
