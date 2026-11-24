// 应用的全部文档 = 主窗 document + 当前 dockview popout 子窗的 document。
//
// popout 子窗里的面板由主窗 React 经 portal 渲染,代码运行在主窗 JS 环境:全局 document 恒为主窗,子窗的
// 按键只派发到子窗 document。全局热键要在子窗生效,须在每个应用文档上挂监听(addAppDocumentsListener)。
// 子窗文档由 shell/dock/popout-documents 按 dockview 组位置登记 / 注销。
// 不会重复触发:一个按键事件只在其所在文档派发;同一文档重复登记按引用计数,只挂一个监听。

const popoutDocs = new Map<Document, number>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const s of [...subscribers]) s();
}

/** 登记一个 popout 子窗文档;返回注销函数(幂等)。 */
export function registerAppDocument(doc: Document): () => void {
  popoutDocs.set(doc, (popoutDocs.get(doc) ?? 0) + 1);
  if (popoutDocs.get(doc) === 1) notify();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (popoutDocs.get(doc) ?? 1) - 1;
    if (n > 0) {
      popoutDocs.set(doc, n);
      return;
    }
    popoutDocs.delete(doc);
    notify();
  };
}

/** 主窗 document 在首位,其后是已登记的子窗文档。 */
export function getAppDocuments(): Document[] {
  return [document, ...[...popoutDocs.keys()].filter((d) => d !== document)];
}

/** 在所有应用文档上挂监听,子窗增删时自动跟随;返回释放函数。 */
export function addAppDocumentsListener<K extends keyof DocumentEventMap>(
  type: K,
  listener: (e: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): () => void {
  const attached = new Set<Document>();
  const sync = (): void => {
    const current = new Set(getAppDocuments());
    for (const doc of attached) {
      if (current.has(doc)) continue;
      doc.removeEventListener(type, listener, options);
      attached.delete(doc);
    }
    for (const doc of current) {
      // 同一 (type, listener, capture) 重复 addEventListener 由 DOM 去重,已挂的文档不会挂第二份。
      doc.addEventListener(type, listener, options);
      attached.add(doc);
    }
  };
  sync();
  subscribers.add(sync);
  return () => {
    subscribers.delete(sync);
    for (const doc of attached) doc.removeEventListener(type, listener, options);
    attached.clear();
  };
}
