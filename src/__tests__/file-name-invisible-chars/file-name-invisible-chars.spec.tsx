// @vitest-environment jsdom
// BDD: file-name-invisible-chars / 文件名里的双向控制 / 零宽字符在资源管理器、tab、Quick Open、搜索结果、确认框里可见化
// (`‮txt.exe` 不再显示成 `exe.txt`);只改显示 —— 等长替换,匹配高亮下标不变,实际路径不变。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { revealInvisibleChars } from '../../lib/untrusted-text';
import { editorTabTitle } from '../../panels/Editor/untitled';
import { highlightMatches } from '../../plugins/picker/highlight-matches';
import { ConfirmDialog } from '../../lib/ConfirmDialog';

afterEach(() => cleanup());

const RLO_NAME = 'invoice‮txt.exe';

describe('revealInvisibleChars', () => {
  it('双向控制、零宽空格 / 连接符、BOM、控制字符(含换行)→ U+FFFD,等长', () => {
    for (const ch of ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '‎', '‏', '؜', '​', '⁠', '﻿', '\n', '\t', '\u0007']) {
      const out = revealInvisibleChars(`a${ch}b`);
      expect(out, ch.codePointAt(0)!.toString(16)).toBe('a�b');
    }
    expect(revealInvisibleChars(RLO_NAME)).toHaveLength(RLO_NAME.length);
  });

  it('正常文字不变:中文 / 韩文 / emoji ZWJ 组合 / 波斯文 ZWNJ', () => {
    for (const s of ['报告.md', '보고서.md', '👨‍👩‍👧.png', 'می‌خواهم.txt']) expect(revealInvisibleChars(s)).toBe(s);
  });
});

describe('各处显示', () => {
  it('tab 标题(及标题栏 / 状态栏 / 确认框经 editorTabTitle 取的名字)', () => {
    expect(editorTabTitle(`/w/${RLO_NAME}`)).toBe('invoice�txt.exe');
  });

  it('Quick Open 等选择器的高亮:替换后下标照旧对得上', () => {
    const { container } = render(<div>{highlightMatches(RLO_NAME, [8, 9, 10])}</div>);
    expect(container.textContent).toBe('invoice�txt.exe');
    expect(container.querySelector('mark')!.textContent).toBe('txt');
  });

  it('确认框标题', () => {
    const { getByRole } = render(
      <ConfirmDialog open title={`删除「${RLO_NAME}」?`} description="" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(getByRole('dialog').querySelector('h2')!.textContent).toBe('删除「invoice�txt.exe」?');
  });
});
