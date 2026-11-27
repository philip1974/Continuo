// popout 子窗跟随主窗 <head> 里后加 / 移除 / 改写的样式(VSCode auxiliaryWindowService.applyCSS 同:MutationObserver
// 监听主窗 head 的 childList + subtree,新 <style> / <link> 克隆进子窗,原节点移除则移除克隆,<style> 文本变化写进克隆)。
//
// dockview 只在子窗打开时把主窗 document.styleSheets 抄一次(popoutWindow.js addStyles);之后懒加载 chunk 才插进主窗
// head 的 CSS(生产:Vite 预加载的 <link rel=stylesheet>,如 MilkdownEditor / TerminalPanelView;dev:Vite 注入的
// <style> 与其 HMR 文本更新)到不了子窗 → 子窗里首次加载的 Markdown 编辑模式 / 终端完全无样式。
//
// 不重复:子窗开窗时主窗已有的 <style> 已被 dockview 按规则抄过 → 记为已有、不克隆;<link> 按绝对 href 去重(dockview
// 抄的 link、子窗自己 index.html 的 link 都带 href;开窗时尚未加载完的 link 不在 styleSheets 里、dockview 漏抄,这里补上)。
// CodeMirror / ProseMirror 的 StyleModule 按视图所在 document 挂载(editor-popout-root 的 setRoot),不经这里。
import { getPopoutDocuments, subscribePopoutDocuments } from './popout-documents';

type StyleNode = HTMLStyleElement | HTMLLinkElement;

interface Target {
  /** 开窗时主窗已有、已由 dockview 抄过的 <style>。 */
  readonly existing: WeakSet<Node>;
  /** 主窗原节点 → 子窗克隆。 */
  readonly clones: Map<Node, Element>;
}

function isStyleNode(node: Node): node is StyleNode {
  if (node.nodeName === 'STYLE') return true;
  return node.nodeName === 'LINK' && (node as HTMLLinkElement).relList.contains('stylesheet');
}

function hasLink(doc: Document, href: string): boolean {
  for (const el of doc.head.querySelectorAll('link')) {
    if (el.relList.contains('stylesheet') && el.href === href) return true;
  }
  return false;
}

function cloneInto(doc: Document, target: Target, node: StyleNode): void {
  if (target.clones.has(node) || target.existing.has(node)) return;
  if (node.nodeName === 'LINK' && hasLink(doc, (node as HTMLLinkElement).href)) return;
  const clone = node.cloneNode(true) as Element;
  // 绝对地址:子窗 URL 与主窗同源同路径,但不依赖相对解析。
  if (node.nodeName === 'LINK') (clone as HTMLLinkElement).href = (node as HTMLLinkElement).href;
  doc.head.appendChild(clone);
  target.clones.set(node, clone);
}

export function trackPopoutStylesheets(): { dispose: () => void } {
  const head = document.head;
  const targets = new Map<Document, Target>();

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== 'childList') continue;
      const name = record.target.nodeName;
      if (name === 'TITLE' || name === 'SCRIPT' || name === 'META') continue;
      for (const [doc, target] of targets) {
        // <style> 文本变化(Vite HMR 的 textContent 替换)→ 写进克隆
        const textClone = target.clones.get(record.target);
        if (textClone) textClone.textContent = record.target.textContent;
        for (const node of record.addedNodes) {
          // 同一批里加了又删的节点不克隆(removedNodes 记录也找不到克隆)
          if (isStyleNode(node) && node.parentNode === head) cloneInto(doc, target, node);
        }
        for (const node of record.removedNodes) {
          const clone = target.clones.get(node);
          if (!clone) continue;
          clone.remove();
          target.clones.delete(node);
        }
      }
    }
  });

  const attach = (doc: Document): Target => {
    const target: Target = { existing: new WeakSet(), clones: new Map() };
    for (const node of head.querySelectorAll<StyleNode>('link[rel~="stylesheet"], style')) {
      if (node.nodeName === 'STYLE') target.existing.add(node);
      else cloneInto(doc, target, node);
    }
    return target;
  };

  const sync = (): void => {
    const docs = getPopoutDocuments();
    for (const doc of targets.keys()) if (!docs.includes(doc)) targets.delete(doc);
    for (const doc of docs) if (!targets.has(doc)) targets.set(doc, attach(doc));
    if (targets.size === 0) observer.disconnect();
    else observer.observe(head, { childList: true, subtree: true });
  };

  const unsubscribe = subscribePopoutDocuments(sync);
  sync();

  return {
    dispose: () => {
      unsubscribe();
      observer.disconnect();
      targets.clear();
    },
  };
}
