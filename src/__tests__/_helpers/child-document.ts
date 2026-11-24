// jsdom 下模拟 dockview popout 子窗:同源 iframe 的 document / window。
// 生产中弹出的面板 / header 由主窗 React 经 portal 渲染进子窗 DOM,代码运行在主窗 JS 环境
// (全局 window / document 恒为主窗);组件挂在这里时只能经 ownerDocument 找到所在窗口。

export interface ChildDocument {
  readonly doc: Document;
  readonly win: Window;
  /** 子文档 body 下的挂载点(给 RTL render 的 container)。 */
  readonly host: HTMLElement;
  readonly dispose: () => void;
}

export function makeChildDocument(): ChildDocument {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) throw new Error('jsdom iframe 未提供 contentDocument');
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  return { doc, win, host, dispose: () => iframe.remove() };
}

export function keydown(
  target: Document | Element,
  init: KeyboardEventInit,
): KeyboardEvent {
  const doc = 'defaultView' in target ? target : target.ownerDocument;
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const Ctor = win?.KeyboardEvent ?? KeyboardEvent;
  const e = new Ctor('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
