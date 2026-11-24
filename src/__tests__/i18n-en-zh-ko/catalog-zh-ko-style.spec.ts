// @vitest-environment node
// zh / ko 文案的术语与标点一致性(对齐 VSCode 中文 / 韩文版):
// - 术语:Quick Open →「快速打开」/「빠른 열기」(与已译的「命令面板」/「명령 팔레트」同级);本产品的扩展统一叫「插件」/「플러그인」。
// - zh 中文排版:句内逗号 / 分号 / 问号 / 叹号 / 冒号用全角;含中文或紧跟汉字的括号用全角「（）」;引号统一「」。
//   代码(反引号内)、占位符之间(`{src}: {message}`)、快捷键与英文片段内部保留半角。
import { describe, expect, it } from 'vitest';
import { ko } from '../../../electron/shared/i18n-locales/ko';
import { zh } from '../../../electron/shared/i18n-locales/zh';

const CJK = '[\\u3400-\\u9fff]';

/** 去掉反引号代码段(其内标点按代码原样)。 */
const stripCode = (value: string): string => value.replace(/`[^`]*`/g, '');

const ZH_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['半角逗号 / 分号 / 问号 / 叹号紧邻汉字', new RegExp(`${CJK}[,;?!]|[,;?!] ?${CJK}`)],
  ['半角冒号紧跟汉字', new RegExp(`${CJK}:`)],
  ['含中文或紧跟汉字的半角括号', new RegExp(`${CJK} ?\\(|\\([^()]*${CJK}[^()]*\\)`)],
  ['弯引号(统一用「」)', /[“”]/],
  ['未译的 Quick Open(用「快速打开」)', /Quick Open/],
  ['「扩展」(本产品统一叫「插件」)', /扩展/],
];

const KO_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['未译的 Quick Open(用「빠른 열기」)', /Quick Open/],
  ['「확장」(本产品统一叫「플러그인」)', /확장/],
];

/**
 * 由组件拼接、与相邻的命令名 / 键帽 / 英文标题之间**由代码补半角空格**的片段:改成全角会出现「命令： Command A」
 * 「Terminal 1 （已退出）」这样的双重间距,须连同拼接处一起改(KeybindingCaptureModal / terminal-panel-id),暂豁免。
 */
const ZH_FRAGMENT_KEYS: ReadonlySet<string> = new Set([
  'keybindings.modal.command_label',
  'keybindings.modal.hint_press_save',
  'keybindings.modal.hint_save',
  'keybindings.modal.hint_clear',
  'keybindings.modal.hint_default',
  'panels.terminal.exited_suffix',
]);

function violations(
  catalog: Record<string, string>,
  rules: typeof ZH_RULES,
  exempt: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (exempt.has(key)) continue;
    const text = stripCode(value);
    for (const [name, re] of rules) if (re.test(text)) out.push(`${key} [${name}]: ${value}`);
  }
  return out;
}

describe('zh / ko 文案术语与标点', () => {
  it('zh:全角中文标点、「」引号、术语统一', () => {
    expect(violations(zh, ZH_RULES, ZH_FRAGMENT_KEYS)).toEqual([]);
  });

  it('ko:术语统一(빠른 열기 / 플러그인)', () => {
    expect(violations(ko, KO_RULES)).toEqual([]);
  });

  it('规则本身有鉴别力:典型违例都能被识别', () => {
    const bad = {
      comma: '失败,请重试',
      colon: '退出代码: {code}',
      paren: '回复(stop hook)',
      quote: '删除“{name}”吗',
      term: '与 Quick Open 冲突',
    };
    expect(violations(bad, ZH_RULES).map((v) => v.split(' ')[0])).toEqual([
      'comma',
      'colon',
      'paren',
      'quote',
      'term',
    ]);
    // 代码段与占位符之间的半角标点不算
    expect(violations({ ok: '执行 `a(b, c)` 后，', ok2: '移动失败：{src}: {message}' }, ZH_RULES)).toEqual([]);
  });
});
