// 第十一轮 · P2-AC 所有 popout 判定消费方统一走 isPopoutUrl helper
//
// topic-49 P2-E 建了 electron/main/popout-url.ts(URLSearchParams 精确判定),
// 但只接入了 index.ts。agent-auth.service / mcp-stdio-server.service 三处仍用裸
// 子串 `includes('popout=1')` → workspace 路径含该子串的普通主窗被误判为 popout,
// 授权弹窗 / MCP tools/call fallback 路由到错误窗口。
// 本守卫:静态断言这些消费方不再出现裸子串判定(防回退),且都 import isPopoutUrl。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

// popout-url.ts 自身的注释里会出现 `includes('popout=1')` 字样(讲解旧 bug),
// 故它不在被扫描列表内。仅扫描消费方实现文件。
const CONSUMER_FILES = [
  'electron/main/services/agent-auth.service.ts',
  'electron/main/services/mcp-stdio-server.service.ts',
  'electron/main/index.ts',
];

describe('49 · popout 判定消费方统一走 isPopoutUrl', () => {
  it.each(CONSUMER_FILES)('%s 不含裸子串 includes(popout=1) 判定', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf-8');
    expect(src).not.toMatch(/includes\(\s*['"]popout=1['"]\s*\)/);
  });

  it.each(CONSUMER_FILES)('%s import isPopoutUrl helper', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf-8');
    expect(src).toMatch(/isPopoutUrl/);
  });
});
