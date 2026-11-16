// 终审 P1:取消退出会永久停用 terminal.await_stop_hook。
// 旧实现在 MCP host 启动处另挂 `app.once('before-quit', () => broker.stop())`:退出一开始就停 broker;
// 若用户在未保存确认框取消(或保存失败中止退出),broker 不会重启 → 之后 await_stop_hook 全部报
// "broker stopped" 直至重启应用。修复:只在主 before-quit 的不可逆清理阶段(全局最终检查通过、
// cancelAllAgentAuth 之后)停止 broker。主进程退出链路依赖整套启动,这里按仓库惯例做接线源码钉。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');

describe('hook broker 只在不可逆退出清理阶段停止', () => {
  it('不再有退出一开始就停 broker 的独立 before-quit 监听', () => {
    expect(src).not.toMatch(/app\.once\(\s*['"]before-quit['"][\s\S]{0,200}broker\.stop\(\)/);
  });

  it('停止 broker 发生在 cancelAllAgentAuth 之后、app.quit 之前', () => {
    const cancelAt = src.indexOf('cancelAllAgentAuth();');
    const stopAt = src.indexOf('stopHookBroker?.()');
    const quitAt = src.indexOf('app.quit();', cancelAt);
    expect(cancelAt).toBeGreaterThan(0);
    expect(stopAt).toBeGreaterThan(cancelAt);
    expect(quitAt).toBeGreaterThan(stopAt);
  });
});
