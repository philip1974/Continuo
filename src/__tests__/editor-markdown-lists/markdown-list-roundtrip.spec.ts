// @vitest-environment jsdom
// 真实 Crepe(不 mock):Markdown 列表在 Milkdown(Edit / Preview 共用的引擎)里解析 → 渲染 → 序列化往返。
// 回归:@milkdown/preset-commonmark 7.20 的 spread attr 声明 validate:"boolean",解析器却传字符串
// "true"/"false",prosemirror-model 1.25 校验失败 → 列表节点整段丢失(显示空白,保存后文件里的列表消失)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';

const editors: Crepe[] = [];

async function open(markdown: string): Promise<{ crepe: Crepe; root: HTMLElement }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    // 与 MilkdownEditor 一致:不启用图片 / 公式
    features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
  });
  configureMarkdownStyle(crepe, markdown); // 与 MilkdownEditor 一致:列表符号跟随原文件(这里是 `-`)
  editors.push(crepe);
  await crepe.create();
  return { crepe, root };
}

afterEach(async () => {
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const TIGHT = ['- apple', '- banana', '  - nested one', '  - nested two', '- cherry', '', '1. first', '2. second', '3. third', ''].join('\n');

const LOOSE = ['- alpha', '', '- beta', '', '- gamma', '', 'tail paragraph', ''].join('\n');

describe('Markdown 列表经 Milkdown 渲染与往返', () => {
  it('无序 / 有序 / 嵌套列表渲染成列表项,解析时不报 spread 类型错误', async () => {
    const errors = vi.spyOn(console, 'error');
    const { root } = await open(TIGHT);
    const items = [...root.querySelectorAll('.ProseMirror li')].map((li) => li.textContent?.trim() ?? '');
    expect(root.querySelectorAll('.ProseMirror ul').length).toBeGreaterThanOrEqual(2);
    expect(root.querySelector('.ProseMirror ol')).not.toBeNull();
    for (const text of ['apple', 'banana', 'nested one', 'nested two', 'cherry', 'first', 'second', 'third']) {
      expect(items.some((t) => t.includes(text))).toBe(true);
    }
    const spreadErrors = errors.mock.calls.filter((args) => String(args[0]).includes('spread'));
    expect(spreadErrors).toEqual([]);
  });

  it('紧凑列表往返后仍是紧凑列表,内容与嵌套层级都在', async () => {
    const { crepe } = await open(TIGHT);
    const out = crepe.getMarkdown();
    expect(out).toMatch(/^- apple\n- banana\n {2}- nested one\n {2}- nested two\n- cherry$/m);
    expect(out).toMatch(/^1\. first\n2\. second\n3\. third$/m);
  });

  it('松散列表(项之间空行)往返后仍松散', async () => {
    const { crepe } = await open(LOOSE);
    const out = crepe.getMarkdown();
    expect(out).toMatch(/^- alpha\n\n- beta\n\n- gamma$/m);
    expect(out).toContain('tail paragraph');
  });

  it('任务列表(GFM)往返后勾选状态保持', async () => {
    const { crepe, root } = await open('- [ ] todo\n- [x] done\n');
    expect(root.querySelectorAll('.ProseMirror li').length).toBe(2);
    const out = crepe.getMarkdown();
    expect(out).toMatch(/^- \[ \] todo\n- \[x\] done$/m);
  });

  it('输入后再序列化(保存路径)列表不丢', async () => {
    const { crepe } = await open(TIGHT);
    const view = crepe.editor.ctx.get<
      { state: { doc: { content: { size: number } }; tr: { insertText: (t: string, p: number) => unknown } }; dispatch: (tr: unknown) => void },
      'editorView'
    >('editorView');
    view.dispatch(view.state.tr.insertText('X', 3));
    const out = crepe.getMarkdown();
    expect(out).toMatch(/apple/);
    expect(out).toMatch(/^- /m);
    expect(out).toMatch(/^1\. first$/m);
  });
});
