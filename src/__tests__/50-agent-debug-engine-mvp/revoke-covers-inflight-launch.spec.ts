// 终审 P1:用户「撤销 agent 授权」时,在途 debug.launch(adapter 启动 / initialize 中、会话尚未登记)
// 不在已登记会话里 → 撤销按已登记会话枚举调用方会漏掉它,随后照常登记、留下绑定已吊销 token 的会话。
// 修复:撤销枚举调用方改用 DebugService.listControllerTokens()(含在途 launch);在途 launch 本身的
// 自行拆除由 electron/main/__tests__/debug-service.spec.ts 覆盖。主进程接线依赖整套启动,这里做源码钉。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');

describe('撤销 agent 授权覆盖在途 debug launch', () => {
  it('撤销枚举的调用方取自 debugService.listControllerTokens()(含在途 launch)', () => {
    const start = src.indexOf('setAgentAuthControllerTeardown({');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('\n    });', start));
    expect(block).toMatch(/listControllerTokens:\s*\(\)\s*=>\s*debugService\.listControllerTokens\(\)/);
  });
});
