// BDD: quick-open-file-line 第 3 条 —— ⌘P `文件:行` 打开时行列越界夹到文档范围(clampToDocument);Markdown 编辑 / 预览按源码行夹取。
// 插件 API(editor.openFile)不夹取,越界仍报 line-out-of-range。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coApp, openFileInEditor } from '@/plugins/co-app';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { useEditorStore } from '@/stores/editor.store';
import { revealInMarkdown } from '@/panels/Editor/markdown-reveal-registry';
import { textGotoLineDoc } from '@/plugins/quick-open/goto-line';

vi.mock('@/panels/Editor/editor-file-actions', () => ({ openFileByPath: vi.fn() }));
vi.mock('@/panels/Editor/markdown-reveal-registry', () => ({ revealInMarkdown: vi.fn() }));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: { readFile: vi.fn(), writeFile: vi.fn() } } }));

const MD = '/work/readme.md';
const CONTENT = '# title\r\n\r\nshort\nlast line';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(openFileByPath).mockResolvedValue({ ok: true, data: undefined });
  vi.mocked(revealInMarkdown).mockResolvedValue('applied');
  useEditorStore.setState({
    tabs: [{ id: MD, filePath: MD, content: CONTENT, originalContent: CONTENT, dirty: false }],
    activeTabId: MD,
    mode: 'edit',
  } as Partial<ReturnType<typeof useEditorStore.getState>>);
});

describe('打开并定位:越界夹到文档范围', () => {
  it('Markdown 编辑 / 预览:行号越界 → 最后一个源码行;列越界 → 行尾', async () => {
    await openFileInEditor(MD, { line: 9999 }, { preview: false }, { clampToDocument: true });
    expect(revealInMarkdown).toHaveBeenLastCalledWith(MD, { line: 4, column: undefined, length: undefined });
    await openFileInEditor(MD, { line: 3, column: 99 }, { preview: false }, { clampToDocument: true });
    expect(revealInMarkdown).toHaveBeenLastCalledWith(MD, { line: 3, column: 6, length: undefined });
  });

  it('插件 API editor.openFile 不夹取(越界原样交给定位,由其报 line-out-of-range)', async () => {
    await coApp.editor.openFile(MD, { line: 9999 });
    expect(revealInMarkdown).toHaveBeenLastCalledWith(MD, { line: 9999, column: undefined, length: undefined });
  });

  it('源码文本按 \\n / \\r\\n / \\r 切行', () => {
    const doc = textGotoLineDoc('a\r\nbb\rccc\n');
    expect(doc.lines).toBe(4);
    expect([1, 2, 3, 4].map((n) => doc.line(n).length)).toEqual([1, 2, 3, 0]);
  });
});
