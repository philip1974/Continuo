// BDD: Windows stdio MCP 命名管道每次启动随机命名 + 发现文件
//
// 攻击场景:Windows 命名管道的命名空间全机共享、不分用户。可预测的管道名(固定名,或仅由用户名 / profile
// 目录推导的名字)下,同机另一用户 B 先创建同名管道 → A 的 Continuo 绑定失败(EADDRINUSE,被吞成告警),
// A 终端里 claude 启动的 stdio proxy 连到 B 的管道,并在 hello 中把 {windowId, token} 发给 B → B 拿 token
// 调 A 的 HTTP MCP。
// 修复:主进程每次启动用 `\\.\pipe\continuo-mcp-<用户哈希>-<128 bit 随机>`,B 无从预知;proxy 获取名字的途径:
//   1. Continuo PTY 注入的 CONTINUO_MCP_SOCKET(proxy 本就优先读);
//   2. 否则读 `<userData>/mcp-pipe` 发现文件(%APPDATA%\Continuo → %APPDATA%\Continuo Dev;profile 目录默认仅本用户可写);
//   读不到 / 内容不是合法本机 continuo-mcp 管道名 → 报错退出,绝不回落到确定性名。

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(), getAllWindows: vi.fn(() => []) },
}));

import {
  createStdioSocketServer,
  createWindowsStdioPipeName,
  isValidWindowsStdioPipeName,
  STDIO_PIPE_DISCOVERY_FILE,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import { createContinuoMcpEnv } from '../../../electron/main/services/continuo-terminal-host-adapter';

const ROOT = path.resolve(__dirname, '../../..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts/continuo-mcp-stdio.mjs');

interface ProxyDiscovery {
  WINDOWS_PIPE_NAME_RE: RegExp;
  readWindowsPipeDiscovery: (appDataDir: string) => string | null;
}

/** 取出独立 proxy 脚本里的发现段(脚本顶层会直接连 socket,不能 import)。 */
function loadProxyDiscovery(): ProxyDiscovery {
  const src = nodeFs.readFileSync(PROXY_SCRIPT, 'utf8');
  const m = /\/\/ <windows-pipe-discovery>\n([\s\S]*?)\/\/ <\/windows-pipe-discovery>/.exec(src);
  if (!m) throw new Error('proxy 脚本缺少 <windows-pipe-discovery> 标记段');
  return new Function(
    'readFileSync',
    'path',
    `${m[1]}\nreturn { WINDOWS_PIPE_NAME_RE, readWindowsPipeDiscovery };`,
  )(nodeFs.readFileSync, path) as ProxyDiscovery;
}

const alice = { username: 'alice', homedir: 'C:\\Users\\alice' };
const bob = { username: 'bob', homedir: 'C:\\Users\\bob' };
const NAME_RE = /^\\\\\.\\pipe\\continuo-mcp-([0-9a-f]{32})-([0-9a-f]{32})$/;

const INVALID_NAMES = [
  '',
  '\\\\.\\pipe\\continuo-mcp',
  '\\\\.\\pipe\\continuo-mcp-',
  '\\\\.\\pipe\\evil',
  '\\\\.\\pipe\\continuo-mcp-ABC',
  '\\\\.\\pipe\\continuo-mcp-ab\\..\\evil',
  '\\\\attacker-host\\pipe\\continuo-mcp-abcd', // 远程管道:连过去 = 把 token 发到别的机器
  '\\\\?\\pipe\\continuo-mcp-abcd',
  'C:\\Users\\bob\\continuo-mcp-abcd',
  '/tmp/continuo-mcp-abcd',
  '\\\\.\\pipe\\continuo-mcp-abcd\nextra',
];

describe('管道名每次启动随机', () => {
  it('形如 \\\\.\\pipe\\continuo-mcp-<用户哈希>-<128 bit 随机>,每次不同', () => {
    const a = createWindowsStdioPipeName(alice);
    const b = createWindowsStdioPipeName(alice);
    expect(a).toMatch(NAME_RE);
    expect(b).toMatch(NAME_RE);
    expect(a).not.toBe(b);
    // 同用户哈希段稳定,随机段不同
    expect(NAME_RE.exec(a)![1]).toBe(NAME_RE.exec(b)![1]);
    expect(NAME_RE.exec(a)![2]).not.toBe(NAME_RE.exec(b)![2]);
  });

  it('不同用户的哈希段不同(大小写不敏感)', () => {
    const hash = (u: typeof alice) => NAME_RE.exec(createWindowsStdioPipeName(u))![1];
    expect(hash(alice)).not.toBe(hash(bob));
    expect(hash(alice)).toBe(hash({ username: 'ALICE', homedir: 'c:\\users\\Alice' }));
    expect(hash(alice)).toBe(
      createHash('sha256').update('alice\0c:\\users\\alice', 'utf8').digest('hex').slice(0, 32),
    );
  });

  it('只接受本机 continuo-mcp 管道名', () => {
    expect(isValidWindowsStdioPipeName(createWindowsStdioPipeName(alice))).toBe(true);
    for (const bad of INVALID_NAMES) expect(isValidWindowsStdioPipeName(bad)).toBe(false);
  });

  it('proxy 脚本与主进程的合法名校验一致', () => {
    const { WINDOWS_PIPE_NAME_RE } = loadProxyDiscovery();
    for (const s of [createWindowsStdioPipeName(bob), ...INVALID_NAMES]) {
      expect(WINDOWS_PIPE_NAME_RE.test(s)).toBe(isValidWindowsStdioPipeName(s));
    }
  });
});

describe('PTY 注入 CONTINUO_MCP_SOCKET', () => {
  it('给出 stdioSocketPath 时注入,未给出时不注入', () => {
    const base = { windowId: 7, url: 'http://127.0.0.1:1/mcp', issueToken: () => 't' };
    expect(createContinuoMcpEnv({ ...base, stdioSocketPath: '\\\\.\\pipe\\continuo-mcp-ab-cd' }).env)
      .toMatchObject({ CONTINUO_MCP_SOCKET: '\\\\.\\pipe\\continuo-mcp-ab-cd', CONTINUO_MCP_TOKEN: 't' });
    expect(createContinuoMcpEnv(base).env).not.toHaveProperty('CONTINUO_MCP_SOCKET');
  });

  it('主进程 Windows 上用随机名并把它注入 PTY env、写发现文件', () => {
    const src = nodeFs.readFileSync(path.join(ROOT, 'electron/main/index.ts'), 'utf8');
    const fn = /function resolveStdioSocketPath\(\): string \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(/createWindowsStdioPipeName\(os\.userInfo\(\)\)/);
    expect(src).toMatch(/stdioSocketPath: process\.platform === 'win32' \? resolveStdioSocketPath\(\) : undefined/);
    expect(src).toMatch(/discoveryFile: process\.platform === 'win32'\s*\?\s*path\.join\(app\.getPath\('userData'\), STDIO_PIPE_DISCOVERY_FILE\)/);
  });
});

describe('发现文件', () => {
  const dirs: string[] = [];
  const servers: StdioSocketServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tmp(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'pipe-disc-'));
    dirs.push(d);
    return d;
  }

  it('server listen 成功后写入监听名,close 时删除', async () => {
    const dir = await tmp();
    const socketPath = path.join(dir, 's.sock');
    const discoveryFile = path.join(dir, STDIO_PIPE_DISCOVERY_FILE);
    const server = await createStdioSocketServer({
      socketPath,
      discoveryFile,
      tools: new Map(),
      serverInfo: { name: 't', version: '0', protocolVersion: '2024-11-05' },
      resolveWindowId: () => null,
    });
    expect(await readFile(discoveryFile, 'utf8')).toBe(socketPath);
    await server.close();
    expect(nodeFs.existsSync(discoveryFile)).toBe(false);
  });

  it('close 时发现文件已被换成别的名字 → 不删(不误删后来者)', async () => {
    const dir = await tmp();
    const discoveryFile = path.join(dir, STDIO_PIPE_DISCOVERY_FILE);
    const server = await createStdioSocketServer({
      socketPath: path.join(dir, 's.sock'),
      discoveryFile,
      tools: new Map(),
      serverInfo: { name: 't', version: '0', protocolVersion: '2024-11-05' },
      resolveWindowId: () => null,
    });
    await writeFile(discoveryFile, 'someone-else');
    await server.close();
    expect(await readFile(discoveryFile, 'utf8')).toBe('someone-else');
  });

  it('proxy 发现文件名与主进程一致', () => {
    const src = nodeFs.readFileSync(PROXY_SCRIPT, 'utf8');
    expect(src).toContain(`'${STDIO_PIPE_DISCOVERY_FILE}'`);
  });

  it('proxy 按 Continuo → Continuo Dev 顺序读,跳过非法内容,都没有返回 null', async () => {
    const { readWindowsPipeDiscovery } = loadProxyDiscovery();
    const appData = await tmp();
    const packagedName = createWindowsStdioPipeName(alice);
    const devName = createWindowsStdioPipeName(alice);
    const put = async (app: string, content: string) => {
      await mkdir(path.join(appData, app), { recursive: true });
      await writeFile(path.join(appData, app, STDIO_PIPE_DISCOVERY_FILE), content);
    };

    expect(readWindowsPipeDiscovery(appData)).toBeNull();

    await put('Continuo Dev', `${devName}\n`);
    expect(readWindowsPipeDiscovery(appData)).toBe(devName);

    await put('Continuo', packagedName);
    expect(readWindowsPipeDiscovery(appData)).toBe(packagedName);

    // packaged 发现文件被写成别的路径 → 不用,落到 dev
    await put('Continuo', '\\\\attacker-host\\pipe\\continuo-mcp-abcd');
    expect(readWindowsPipeDiscovery(appData)).toBe(devName);

    await put('Continuo Dev', 'C:\\evil');
    expect(readWindowsPipeDiscovery(appData)).toBeNull();
  });

  it('proxy Windows 分支:无 env 时只走发现文件,读不到报错退出,不回落确定性名', () => {
    const src = nodeFs.readFileSync(PROXY_SCRIPT, 'utf8');
    expect(src).not.toMatch(/function windowsStdioPipeName/);
    expect(src).toMatch(/process\.platform === 'win32'\) return readWindowsPipeDiscovery\(windowsAppDataDir\(\)\);/);
    expect(src).toMatch(/process\.platform === 'win32' && socketPath === null[\s\S]{0,400}process\.exit\(1\)/);
  });
});
