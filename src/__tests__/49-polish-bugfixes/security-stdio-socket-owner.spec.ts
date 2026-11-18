// BDD: POSIX 上 stdio proxy 只连属于当前用户的 unix socket
//
// 攻击场景:项目级 MCP 配置(不可信仓库里的 .mcp.json 等)的 env 段把 CONTINUO_MCP_SOCKET 指向同机其它用户监听的
// unix socket。proxy 在 Continuo 终端里启动(env 带 CONTINUO_WINDOW_ID / CONTINUO_MCP_TOKEN),连上后在 hello 里把
// 窗口 token 发给对方 → 对方拿 token 调本用户的 127.0.0.1 HTTP MCP。Windows 分支已有管道名校验;POSIX 此前不校验。
// 修复:连接前校验候选路径 —— 本身是 socket(不跟随符号链接)且属主是当前用户;父目录属主是当前用户且
// group / other 不可写(否则他人可在校验与连接之间换掉 socket)。主进程把 socket 建在 0700 的 userData 里,必然满足。
// 不满足:env 显式指定 → 报错退出(不连接、不发 token、不透传);默认候选 → 跳过。

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts/continuo-mcp-stdio.mjs');
const TOKEN = 'window-token-must-not-leak';

interface FakeStat {
  uid: number;
  mode: number;
  isSocket: () => boolean;
}
type TrustError = (
  socketPath: string,
  uid: number | undefined,
  fs: { lstatSync: (p: string) => FakeStat; statSync: (p: string) => FakeStat },
) => string | null;

/** 取出独立 proxy 脚本里的校验段(脚本顶层会直接连 socket,不能 import)。 */
function loadTrustCheck(): TrustError {
  const src = nodeFs.readFileSync(PROXY_SCRIPT, 'utf8');
  const m = /\/\/ <posix-socket-trust>\n([\s\S]*?)\/\/ <\/posix-socket-trust>/.exec(src);
  if (!m) throw new Error('proxy 脚本缺少 <posix-socket-trust> 标记段');
  return new Function('path', `${m[1]}\nreturn posixSocketTrustError;`)(path) as TrustError;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** unix socket 路径有长度上限(macOS 104):用 /tmp 下的短目录。mkdtemp 建出来就是 0700、属当前用户。 */
async function shortTmp(): Promise<string> {
  const dir = await mkdtemp('/tmp/co-sock-');
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 监听 unix socket,收集对端发来的全部数据。 */
async function listen(p: string): Promise<{ received: () => string }> {
  let data = '';
  const srv = createServer((s) => {
    s.setEncoding('utf8');
    s.on('data', (d: string) => (data += d));
    s.on('error', () => {});
  });
  await new Promise<void>((resolve) => srv.listen(p, resolve));
  cleanups.push(() => new Promise<void>((resolve) => srv.close(() => resolve())));
  return { received: () => data };
}

/** 在「Continuo 终端」环境里启动 proxy(带窗口 token),返回退出码 / stderr。 */
function runProxy(env: Record<string, string>): {
  exited: Promise<number | null>;
  stderr: () => string;
  kill: () => void;
} {
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: { ...process.env, CONTINUO_WINDOW_ID: '1', CONTINUO_MCP_TOKEN: TOKEN, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanups.push(() => void child.kill());
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += String(d)));
  child.stdin.on('error', () => {});
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  return {
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
    stderr: () => stderr,
    kill: () => void child.kill(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.platform === 'win32')('stdio proxy:只连属于当前用户的 unix socket', { timeout: 20_000 }, () => {
  const me = process.getuid!();
  const dirStat = (uid: number, mode: number): FakeStat => ({ uid, mode, isSocket: () => false });
  const sockStat = (uid: number): FakeStat => ({ uid, mode: 0o140600, isSocket: () => true });

  it('校验规则:socket 属主 / 类型、父目录属主与可写位', () => {
    const check = loadTrustCheck();
    const fsWith = (leaf: FakeStat, parent: FakeStat) => ({ lstatSync: () => leaf, statSync: () => parent });

    // 主进程建的 socket:0600、在 0700 的 userData 里 → 通过;父目录 0755 也可(他人不可写)。
    expect(check('/u/Continuo/mcp.sock', me, fsWith(sockStat(me), dirStat(me, 0o40700)))).toBeNull();
    expect(check('/u/Continuo/mcp.sock', me, fsWith(sockStat(me), dirStat(me, 0o40755)))).toBeNull();
    // 别的用户监听的 socket
    expect(check('/tmp/evil.sock', me, fsWith(sockStat(me + 1), dirStat(me, 0o40700)))).toMatch(/not owned/);
    // 不是 socket(普通文件 / 符号链接:lstat 不跟随)
    expect(check('/u/x', me, fsWith(dirStat(me, 0o100600), dirStat(me, 0o40700)))).toMatch(/not a socket/);
    // 父目录属于别人(如 /tmp 属 root)或 group / other 可写
    expect(check('/tmp/mine.sock', me, fsWith(sockStat(me), dirStat(0, 0o41777)))).toMatch(/directory/);
    expect(check('/u/d/mine.sock', me, fsWith(sockStat(me), dirStat(me, 0o40770)))).toMatch(/directory/);
    expect(check('/u/d/mine.sock', me, fsWith(sockStat(me), dirStat(me, 0o40702)))).toMatch(/directory/);
    // stat 失败(不存在等)→ 不在这里判(交给连接报 ENOENT / 试下一个候选)
    const throwing = {
      lstatSync: () => {
        throw new Error('ENOENT');
      },
      statSync: () => dirStat(me, 0o40700),
    };
    expect(check('/u/missing.sock', me, throwing)).toBeNull();
    // 无 getuid(Windows)→ 不适用
    expect(check('\\\\.\\pipe\\continuo-mcp-x', undefined, throwing)).toBeNull();
  });

  it('自己的 socket(0700 目录内)→ 正常连接并发 hello', async () => {
    const dir = await shortTmp();
    const sock = path.join(dir, 'mcp.sock');
    const server = await listen(sock);
    const proxy = runProxy({ CONTINUO_MCP_SOCKET: sock });
    await expect.poll(() => server.received(), { timeout: 10_000 }).toContain('tools/list');
    expect(server.received()).toContain(TOKEN);
    proxy.kill();
  });

  it('env 指向他人可写目录里的 socket → 报错退出,不发 token、不透传任何数据', async () => {
    const dir = await shortTmp();
    const shared = path.join(dir, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o777);
    const sock = path.join(shared, 'evil.sock');
    const server = await listen(sock);

    const proxy = runProxy({ CONTINUO_MCP_SOCKET: sock });
    expect(await proxy.exited).toBe(1);
    expect(proxy.stderr()).toMatch(/CONTINUO_MCP_SOCKET/);
    await sleep(100);
    expect(server.received()).toBe('');
  });

  it('env 指向符号链接(指向一个 socket)→ 报错退出,不发 token', async () => {
    const dir = await shortTmp();
    const real = path.join(dir, 'real.sock');
    const link = path.join(dir, 'link.sock');
    const server = await listen(real);
    await symlink(real, link);

    const proxy = runProxy({ CONTINUO_MCP_SOCKET: link });
    expect(await proxy.exited).toBe(1);
    await sleep(100);
    expect(server.received()).toBe('');
  });

  it('默认候选:packaged socket 的目录他人可写 → 跳过它,连 dev 实例', async () => {
    const home = await shortTmp();
    const support =
      process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
    await mkdir(path.join(support, 'Continuo'), { recursive: true });
    await mkdir(path.join(support, 'Continuo Dev'), { recursive: true });
    await chmod(path.join(support, 'Continuo'), 0o777);
    const untrusted = await listen(path.join(support, 'Continuo', 'mcp.sock'));
    const dev = await listen(path.join(support, 'Continuo Dev', 'mcp.sock'));

    const env: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: support, CONTINUO_MCP_SOCKET: '' };
    const proxy = runProxy(env);
    await expect.poll(() => dev.received(), { timeout: 10_000 }).toContain(TOKEN);
    expect(untrusted.received()).toBe('');
    proxy.kill();
  });

  it('不是 socket 的普通文件 → 报错退出', async () => {
    const dir = await shortTmp();
    const file = path.join(dir, 'not-a-socket');
    await writeFile(file, '');
    const proxy = runProxy({ CONTINUO_MCP_SOCKET: file });
    expect(await proxy.exited).toBe(1);
  });
});
