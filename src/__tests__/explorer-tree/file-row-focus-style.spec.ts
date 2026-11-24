// 文件树行的键盘焦点表现(设计系统):去掉浏览器默认焦点环(macOS 下是系统强调色的橙 / 蓝框),
// 改为 :focus-visible 时 1px 内嵌 --md-focus-ring 轮廓(两主题各有取值,经 @theme inline 暴露为 focus-ring 色)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileRowClassName } from '../../panels/Explorer/FileRow';

const STATES = [
  { isFocused: false, isSelected: false, isDropTarget: false, isCutMarked: false },
  { isFocused: true, isSelected: true, isDropTarget: false, isCutMarked: false },
  { isFocused: true, isSelected: false, isDropTarget: true, isCutMarked: true },
] as const;

describe('FileRow · 键盘焦点样式', () => {
  it('任何状态:outline-none 去掉浏览器默认焦点环,focus-visible 时显示内嵌 focus-ring 轮廓', () => {
    for (const s of STATES) {
      const cls = fileRowClassName(s).split(' ');
      expect(cls).toContain('outline-none');
      expect(cls).toContain('focus-visible:outline-solid');
      expect(cls).toContain('focus-visible:outline-1');
      expect(cls).toContain('focus-visible:-outline-offset-1');
      expect(cls).toContain('focus-visible:outline-focus-ring');
    }
  });

  it('focus-ring 色来自 --md-focus-ring(theme.css @theme inline 映射)', () => {
    const theme = readFileSync(path.resolve(__dirname, '../../styles/theme.css'), 'utf8');
    expect(theme).toMatch(/--color-focus-ring:\s*var\(--md-focus-ring\);/);
  });
});
