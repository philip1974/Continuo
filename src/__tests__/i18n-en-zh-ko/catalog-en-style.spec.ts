// @vitest-environment node
// en 文案引号一致(对齐 VSCode 英文版):引用文件名 / 命令名 / 搜索词等一律用弯引号 “…”,不混用 '…' / "…"。
// 词内撇号(Don't / window's)保持直撇号;反引号代码段内按代码原样。
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
