// BDD: Windows stdio MCP 命名管道按用户命名
//
// 攻击场景:Windows 命名管道的命名空间全机共享、不分用户。旧实现用固定名 `\\.\pipe\continuo-mcp`:
// 同机另一用户 B 先创建同名管道 → A 的 Continuo 绑定失败(EADDRINUSE,被吞成告警),A 终端里 claude
// 启动的 stdio proxy 连到 B 的管道,并在 hello 中把 {windowId, token} 发给 B → B 拿 token 调 A 的 HTTP MCP。
// 修复:管道名带当前用户唯一标识(用户名 + 用户 profile 目录的哈希),server 与独立 proxy 脚本同一算法。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(), getAllWindows: vi.fn(() => []) },
}));

import { windowsStdioPipeName } from '../../../electron/main/services/mcp-stdio-server.service';

const PROXY_SCRIPT = path.resolve(__dirname, '../../../scripts/continuo-mcp-stdio.mjs');

type PipeNameFn = (user: { username: string; homedir: string }) => string;

/** 取出独立 proxy 脚本里的同名函数(脚本顶层会直接连 socket,不能 import)。 */
function loadProxyPipeNameFn(): PipeNameFn {
  const src = readFileSync(PROXY_SCRIPT, 'utf8');
  const m = /\/\/ <windows-pipe-name>\n([\s\S]*?)\/\/ <\/windows-pipe-name>/.exec(src);
  if (!m) throw new Error('proxy 脚本缺少 <windows-pipe-name> 标记段');
  return new Function('createHash', `${m[1]}\nreturn windowsStdioPipeName;`)(createHash) as PipeNameFn;
}

const alice = { username: 'alice', homedir: 'C:\\Users\\alice' };
const bob = { username: 'bob', homedir: 'C:\\Users\\bob' };

describe('Windows stdio MCP 管道名按用户隔离', () => {
  it('不再使用全机固定名,且位于 \\\\.\\pipe\\ 命名空间', () => {
    const name = windowsStdioPipeName(alice);
    expect(name).not.toBe('\\\\.\\pipe\\continuo-mcp');
    expect(name.startsWith('\\\\.\\pipe\\continuo-mcp-')).toBe(true);
  });

  it('不同用户得到不同管道名', () => {
    expect(windowsStdioPipeName(alice)).not.toBe(windowsStdioPipeName(bob));
    // 同名不同 profile 目录(如域用户与本地用户同名)也不同
    expect(windowsStdioPipeName(alice)).not.toBe(
      windowsStdioPipeName({ username: 'alice', homedir: 'C:\\Users\\alice.CORP' }),
    );
  });

  it('同一用户结果稳定,且不受 Windows 大小写差异影响', () => {
    expect(windowsStdioPipeName(alice)).toBe(windowsStdioPipeName({ ...alice }));
    expect(windowsStdioPipeName(alice)).toBe(
      windowsStdioPipeName({ username: 'Alice', homedir: 'c:\\users\\ALICE' }),
    );
  });

  it('proxy 脚本与主进程算法结果一致(同用户连得上自己的 server)', () => {
    const proxyFn = loadProxyPipeNameFn();
    for (const u of [alice, bob, { username: 'Ünï 用户', homedir: 'D:\\Profiles\\Ünï 用户' }]) {
      expect(proxyFn(u)).toBe(windowsStdioPipeName(u));
    }
  });

  it('proxy 脚本 Windows 分支用该函数推导默认路径(不再硬编码固定名)', () => {
    const src = readFileSync(PROXY_SCRIPT, 'utf8');
    expect(src).not.toMatch(/return '\\\\\\\\\.\\\\pipe\\\\continuo-mcp';/);
    expect(src).toMatch(/process\.platform === 'win32'\)\s*return windowsStdioPipeName\(/);
  });
});

describe('主进程按当前用户推导管道名', () => {
  it('resolveStdioSocketPath 的 Windows 分支用 windowsStdioPipeName(os.userInfo())', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../electron/main/index.ts'), 'utf8');
    const fn = /function resolveStdioSocketPath\(\): string \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(/process\.platform === 'win32'\) \{\s*return windowsStdioPipeName\(os\.userInfo\(\)\);/);
  });
});
