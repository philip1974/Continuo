// @vitest-environment jsdom
// BDD:长路径 / 长文件名在对话框与 toast 里折行,韩文界面也一样(keep-all 不再压过 break-all)。见同目录 README。
// jsdom 不排版、不解析层叠,样式规则按源码钉;真实排版由 tests/e2e/long-text-wrap-locale.spec.ts 量。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ConfirmDialog } from '../../lib/ConfirmDialog';
import { UntrustedBlock, UntrustedText } from '../../lib/untrusted-text';

afterEach(() => cleanup());

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 拆出所有 `@layer base { … }` 块的内容与其余(未在 base 层里的)部分(按花括号配对)。 */
function splitBaseLayers(css: string): { inBase: string; outside: string } {
  let inBase = '';
  let outside = '';
  let i = 0;
  const re = /@layer\s+base\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    outside += css.slice(i, m.index);
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    inBase += css.slice(m.index + m[0].length, j - 1);
    i = j;
    re.lastIndex = j;
  }
  outside += css.slice(i);
  return { inBase, outside };
}

/** selector 的规则体(第一处)。 */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `缺少规则 ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('韩文 keep-all 不压过元素自己的折行规则', () => {
  const theme = stripComments(read('src/styles/theme.css'));
  const { inBase, outside } = splitBaseLayers(theme);

  it('keep-all 只设在根元素(:root:lang(ko)),放在 @layer base 里,靠继承下传', () => {
    expect(ruleBody(inBase, ':root:lang(ko)')).toMatch(/word-break:\s*keep-all/);
  });

  it('没有未分层的 :lang(ko) 规则,也没有匹配每个元素的裸 :lang(ko) 选择器', () => {
    expect(outside).not.toMatch(/:lang\(ko\)/);
    expect(inBase).not.toMatch(/(^|[\s,}]):lang\(ko\)/);
  });
});

describe('toast 正文', () => {
  const body = ruleBody(stripComments(read('src/notifications/Toast.css')), '.toast__message');

  it('overflow-wrap: anywhere —— 长路径 / 长文件名在任意处折行', () => {
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('不设 word-break(韩文继承 keep-all 按词断行)', () => {
    expect(body).not.toMatch(/word-break/);
  });
});

describe('ConfirmDialog 标题与说明区', () => {
  it('都带 overflow-wrap:anywhere(长文件名 / 长路径不越出对话框)', () => {
    const name = `${'x'.repeat(200)}.ts`;
    render(<ConfirmDialog open title={name} description={<p>{name}</p>} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = document.querySelector('.wm-modal-content')!;
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(title.className).toContain('[overflow-wrap:anywhere]');
    expect(description.className).toContain('[overflow-wrap:anywhere]');
  });
});

describe('授权弹窗里对方可控的文本', () => {
  it('UntrustedText / UntrustedBlock 的 <code> 自己带 break-all', () => {
    render(
      <>
        <UntrustedText text="/a/very/long/path" />
        <UntrustedBlock text="echo hi" label="命令" />
      </>,
    );
    const codes = [...document.querySelectorAll('code')];
    expect(codes).toHaveLength(2);
    for (const code of codes) expect(code.classList.contains('break-all')).toBe(true);
  });
});
