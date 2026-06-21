// 打磨 R51(codex 性能):fuzzyFilter 把 query.toLowerCase() 从每 item 一次提到整批
// 一次(内部走 fuzzyScoreLower(qLower, target))。本测试守护「fuzzyFilter 仍大小写
// 不敏感」—— 若 hoist 时漏掉 lowercase(直接传 raw query),大写 query 就匹配不到
// 小写 target,故能作 neutralize。
import { describe, it, expect } from 'vitest';
import { fuzzyFilter, fuzzyScore } from '../../plugins/command-palette/fuzzy';

describe('打磨 R51 — fuzzyFilter query 归一化', () => {
  it('大写 query → 仍匹配小写 target(大小写不敏感)', () => {
    const items = ['save file', 'open folder', 'quit app'];
    const out = fuzzyFilter(items, 'SF', (s) => s);
    expect(out).toContain('save file'); // S→save, F→file
  });

  it('混合大小写 query → 与全小写 query 结果一致', () => {
    const items = ['SaveFile', 'openFolder', 'QuitApp'];
    const a = fuzzyFilter(items, 'SaVeFiLe', (s) => s);
    const b = fuzzyFilter(items, 'savefile', (s) => s);
    expect(a).toEqual(b);
    expect(a).toContain('SaveFile');
  });

  it('fuzzyScore 对外契约不变:大写 query 与小写等价', () => {
    expect(fuzzyScore('SAVE', 'save file')).toBe(fuzzyScore('save', 'save file'));
  });
});
