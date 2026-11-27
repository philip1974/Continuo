// 跟随 Markdown 文件链接(编辑 / 预览 / 源码三种模式点链接,见 EditorPanel handleLinkClick):打开文件;带 `#片段` 时定位到
// 对应标题(GitHub slug)或行号(`#L10`),VSCode markdown 语言服务同。BDD: src/__tests__/markdown-anchor-links/
// - 跳转前记下当前位置(后退 ⌃- 回到这里);
// - 同一文档内的锚点不重新打开;跨文件先打开(失败照常提示),再按打开后标签的内容找片段;
// - 找不到对应标题 / 行:只打开(同文档则不动),不报错(VSCode 同)。

import { openFileInEditor } from '@/plugins/co-app';
import { useEditorStore, usesMilkdownEngine } from '@/stores/editor.store';
import { pathEquals } from '@/lib/path-cross';
import { findEditorFileTabByPath } from './editor-tab-lookup';
import { isMarkdownPath } from './editor-path-utils';
import { navigationSelectionAtLine, notifyEditorSelection, recordNavigationOrigin } from './navigation-history';

/**
 * 打开 absPath(currentPath = 链接所在文档;同一文档不重新打开),再定位到 fragment。open = 打开文件(失败已提示);返回是否打开。
 * 返回是否定位到了片段。
 */
export async function followMarkdownLink(
  absPath: string,
  fragment: string | undefined,
  currentPath: string | null,
  open: () => Promise<boolean>,
): Promise<boolean> {
  const sameDocument = currentPath !== null && pathEquals(absPath, currentPath);
  if (!fragment) {
    if (!sameDocument) await open();
    return false;
  }
  if (sameDocument) {
    // 同一文档:先确认片段存在,找不到则什么都不做(不记导航)
    const at = await fragmentTarget(absPath, fragment);
    if (!at) return false;
    recordNavigationOrigin();
    return reveal(absPath, at);
  }
  recordNavigationOrigin();
  if (!(await open())) return false;
  const at = await fragmentTarget(absPath, fragment);
  return at ? reveal(absPath, at) : false;
}

/** 已打开标签里片段的目标位置:Markdown 先找标题;其它文件只认行号片段(VSCode 同)。解析器(lezer)动态加载。 */
async function fragmentTarget(absPath: string, fragment: string): Promise<{ line: number; column?: number } | null> {
  const { resolveMarkdownFragment } = await import('./markdown-fragment');
  const tab = findEditorFileTabByPath(useEditorStore.getState().tabs, absPath);
  if (!tab) return null;
  return resolveMarkdownFragment(tab.content, fragment, isMarkdownPath(tab.filePath));
}

async function reveal(absPath: string, at: { line: number; column?: number }): Promise<boolean> {
  const r = await openFileInEditor(absPath, at.column === undefined ? { line: at.line } : { line: at.line, column: at.column });
  if (!r.ok || !r.lineApplied) return false;
  // Markdown 编辑 / 预览的定位不经 CodeMirror 选区:目标位置在这里记(源码模式由选区变化自动记)
  const s = useEditorStore.getState();
  const tab = findEditorFileTabByPath(s.tabs, absPath);
  if (tab && usesMilkdownEngine(tab.filePath, tab)) {
    notifyEditorSelection(s.activeGroupId, tab.id, navigationSelectionAtLine(at.line));
  }
  return true;
}
