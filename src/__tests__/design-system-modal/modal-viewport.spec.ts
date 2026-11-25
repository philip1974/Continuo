// BDD:矮窗口下对话框不越出窗口(VSCode Quick Input 列表随窗口高度收缩,输入框始终可见)。jsdom 不做布局,
// 按源码钉规则;实测见 tests/e2e(600×400 下 Quick Open / 命令面板输入框在窗口内)。见同目录 README「视口」。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

function ruleBody(src: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[}\\s,])${esc}\\s*\\{([^}]*)\\}`, 'gm');
  return Array.from(src.matchAll(re), (m) => m[1] ?? '').join('\n');
}

describe('Modal 视口约束', () => {
  it('.wm-modal-content 高度不超过视口(上下各留 1rem),超出时内容区自身滚动', () => {
    const body = ruleBody(read('src/design/Modal.css'), '.wm-modal-content');
    expect(body).toMatch(/max-height:\s*calc\(100vh - 2rem\)/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it.each([
    ['Quick Open', 420, 'src/plugins/quick-open/QuickOpenModal.tsx'],
    ['命令面板', 360, 'src/plugins/command-palette/CommandPalette.tsx'],
  ])('%s 结果列表最高 %ipx,且随视口收缩(输入框不被顶出窗口)', (_name, cap, file) => {
    const src = read(file);
    expect(src).toContain(`ref={scrollRef} className="max-h-[min(${cap}px,calc(100vh-8rem))] overflow-y-auto`);
  });
});

describe('主窗最小尺寸', () => {
  it('主窗 BrowserWindow 设 minWidth 400 / minHeight 270(同 VSCode 主窗最小尺寸)', () => {
    const src = read('electron/main/index.ts');
    const opts = src.slice(src.indexOf('export function createMainWindow'));
    const ctor = opts.slice(0, opts.indexOf('});'));
    expect(ctor).toMatch(/minWidth:\s*400\b/);
    expect(ctor).toMatch(/minHeight:\s*270\b/);
  });
});
