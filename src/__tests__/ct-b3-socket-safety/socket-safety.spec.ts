// BDD: ct-b3-socket-safety
// Continuo stdio socket keeps its private hello/dispatch path while adopting
// CT-B1 framing and socket safety semantics.

import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { splitLines as splitNdjsonLines } from '@continuo-terminal/server-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('electron', () => ({
  BrowserWindow: {
    fromId: vi.fn(() => ({
      isDestroyed: () => false,
    })),
    getAllWindows: vi.fn(() => []),
  },
}));

import {
  createStdioSocketServer,
  MAX_STDIO_CLIENTS_GLOBAL_FOR_TEST,
  STDIO_FIRST_MESSAGE_TIMEOUT_MS_FOR_TEST,
  shouldPrepareStdioSocketFilesystem,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import {
  _resetForTest,
  buildClaudeAddCommand,
  getStdioConfig,
  setStdioConfig,
} from '../../../electron/main/services/mcp-stdio-config.service';
import type {
  AnyMcpTool,
  McpCallCtx,
  ServerInfo,
} from '../../../electron/main/services/mcp-host.service';

// 协议级拒绝以 end(PARSE_ERROR) 半关闭、等对端读完后关闭(服务端 1s 兜底 destroy),比旧的立即 destroy
// 多一个往返;vi.waitFor 默认 1s 在高负载下不够,放宽等待上限(只影响失败时多等,不改变断言)。
const REJECT_CLOSE_WAIT = { timeout: 5_000 } as const;

const serverInfo: ServerInfo = {
  name: 'ct-b3-test',
  version: '0',
  protocolVersion: '2024-11-05',
};

async function makeSocketPath(): Promise<{ dir: string; socketPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ct-b3-test-'));
  return { dir, socketPath: path.join(dir, 'mcp.sock') };
}

function ownerTool(): AnyMcpTool {
  return {
    name: 'owner',
    description: 'return owner window id',
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run: (_input: unknown, ctx: McpCallCtx) => ({ ownerWindowId: ctx.ownerWindowId }),
  };
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
}

function waitForLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for socket response')), 2000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
    });
    socket.once('error', reject);
  });
}

describe('CT-B3 stdio socket safety', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const servers: StdioSocketServer[] = [];

  afterEach(async () => {
    _resetForTest();
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function start(socketPath: string, options: Partial<Parameters<typeof createStdioSocketServer>[0]> = {}) {
    const server = await createStdioSocketServer({
      socketPath,
      tools: new Map(),
      serverInfo,
      resolveWindowId: () => null,
      ...options,
    });
    servers.push(server);
    return server;
  }

  it('Windows named pipe skips Unix socket filesystem preparation', () => {
    expect(shouldPrepareStdioSocketFilesystem('win32')).toBe(false);
    expect(shouldPrepareStdioSocketFilesystem('darwin')).toBe(true);
    expect(shouldPrepareStdioSocketFilesystem('linux')).toBe(true);
  });

  it('creates private parent and socket modes', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);

    await start(socketPath);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('throws when a non-empty regular file exists at the socket path', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await writeFile(socketPath, 'not a socket');

    await expect(start(socketPath)).rejects.toThrow(/not a stale socket/);
  });

  it('uses the CT-B1 splitter with SDK CRLF parity', () => {
    const r = splitNdjsonLines('', 'a\r\nb\r\n');

    expect(r).toEqual({ buffer: '', lines: ['a', 'b'] });
  });

  it('auto-chmods an existing group/world-accessible parent directory and warns', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await chmod(dir, 0o755);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await start(socketPath);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('0755 -> 0700'));
  });

  it('unlinks a zero-size regular file at the socket path and warns', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await writeFile(socketPath, '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await start(socketPath);

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('zero-size stale socket placeholder'));
  });

  it('binds _continuo/hello before generic notification discard', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    const resolveWindowId = vi.fn((token: string) => (token === 'tok-42' ? 42 : null));
    await start(socketPath, {
      tools: new Map([['owner', ownerTool()]]),
      resolveWindowId,
    });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);

    socket.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: '_continuo/hello',
        params: { windowId: 42, token: 'tok-42' },
      }) + '\n',
    );
    socket.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'owner', arguments: {} },
      }) + '\n',
    );

    const response = await waitForLine(socket);
    socket.destroy();
    const result = response['result'] as { content: Array<{ text: string }> };
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    expect(JSON.parse(firstContent!.text)).toEqual({ ownerWindowId: 42 });
    expect(resolveWindowId).toHaveBeenCalledWith('tok-42');
  });

  it('buildClaudeAddCommand byte-exact format (CT-B3 UX invariant, source-side)', () => {
    // Byte-exact pin on the SOURCE-side helper that builds the "复制 MCP 配置"
    // content. Format must remain identical across CT-B3 (and future) commits
    // so users do NOT need to re-configure Claude Code MCP after Continuo
    // upgrades. Replaces manual UX verify (dev build → StatusBar 按钮 → paste
    // clipboard → diff) per ADR 0006 CT-B3 plan-v2 P1-1 byte-compat requirement.
    expect(buildClaudeAddCommand('/p')).toBe(
      'claude mcp add --transport stdio continuo -- /p',
    );
    expect(buildClaudeAddCommand('/Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs')).toBe(
      'claude mcp add --transport stdio continuo -- /Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs',
    );
  });

  it('buildClaudeAddCommand Windows:用 node + 引号(.mjs 不可直接执行,路径可能含空格)', () => {
    expect(
      buildClaudeAddCommand('C:\\Program Files\\Continuo\\continuo-mcp-stdio.mjs', 'win32'),
    ).toBe(
      'claude mcp add --transport stdio continuo -- node "C:\\Program Files\\Continuo\\continuo-mcp-stdio.mjs"',
    );
    // 非 win 平台参数 → 保持原 byte-exact 格式
    expect(buildClaudeAddCommand('/p', 'darwin')).toBe(
      'claude mcp add --transport stdio continuo -- /p',
    );
  });

  // 安全:该命令由用户粘贴进 shell(也经 warnIfLegacyUnstableClaudeConfig 写进剪贴板)。路径不加引号时
  // `/Applications/Continuo 2.app/…` 被拆成两个参数(功能坏),路径段含 `;touch X;` / `$(…)` 则粘贴即执行。
  // 契约:含 `[A-Za-z0-9_./-]` 以外字符的路径做 POSIX 单引号转义;常规路径输出逐字节不变(见上)。
  describe.skipIf(process.platform === 'win32')('buildClaudeAddCommand 非 Windows 路径转义(真实 /bin/sh 回读)', () => {
    const PREFIX = 'claude mcp add --transport stdio continuo -- ';
    const HOSTILE_PATHS: ReadonlyArray<readonly [label: string, cliPath: string]> = [
      ['空格', '/Applications/Continuo 2.app/Contents/Resources/continuo-mcp-stdio.mjs'],
      ['分号', '/opt/x;touch PWNED;/continuo-mcp-stdio.mjs'],
      ['$(…)', '/opt/$(touch PWNED)/continuo-mcp-stdio.mjs'],
      ['反引号', '/opt/`touch PWNED`/continuo-mcp-stdio.mjs'],
      ['单引号', "/Users/o'brien/Continuo/continuo-mcp-stdio.mjs"],
      ['双引号与反斜杠', '/opt/a"b\\c/continuo-mcp-stdio.mjs'],
      ['通配与重定向', '/opt/*?[a]>&|~#/continuo-mcp-stdio.mjs'],
      ['中文', '/Users/张三/应用/continuo-mcp-stdio.mjs'],
    ];

    for (const [label, cliPath] of HOSTILE_PATHS) {
      it(`路径含${label} → 恰好一个等于原路径的参数,不执行路径里的任何命令`, async () => {
        const runDir = await mkdtemp(path.join(tmpdir(), 'continuo-claude-add-'));
        dirs.push(runDir);
        const command = buildClaudeAddCommand(cliPath, 'darwin');
        expect(command.startsWith(PREFIX)).toBe(true);
        const argsPart = command.slice(PREFIX.length);

        const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${argsPart}`], {
          cwd: runDir,
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        });

        expect(out).toBe(`${cliPath}\n`);
        expect(await readdir(runDir)).toEqual([]);
      });
    }
  });

  it('preserves getStdioConfig claude add command byte-exact format (round-trip)', () => {
    // Byte-exact verify of the round-trip: setStdioConfig → getStdioConfig
    // returns identical bytes. Combined with buildClaudeAddCommand test above,
    // this pins both source construction AND consumer-visible content.
    const cliPath = '/Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs';
    const expectedCommand = `claude mcp add --transport stdio continuo -- ${cliPath}`;
    setStdioConfig({ claudeAddCommand: expectedCommand });

    const config = getStdioConfig();

    // Byte-exact assertions (no whitespace / flag / quote drift allowed)
    expect(config.claudeAddCommand).toBe(expectedCommand);
    // Format anchored explicitly so future regressions are caught
    expect(config.claudeAddCommand).toBe(
      'claude mcp add --transport stdio continuo -- /Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs',
    );
  });

  // race(R110):同一 stdio socket 的多行 JSON-RPC 须按接收顺序串行处理。并行 fire-and-forget 下
  // 有副作用的工具(terminal.send_text 紧跟 terminal.press_key)会乱序——Enter 先于文本写入 PTY。
  it('R110 同连接多行按接收顺序串行处理(不并行乱序)', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);

    const order: string[] = [];
    const resolvers = new Map<number, () => void>();
    const gate = (n: number): Promise<void> =>
      new Promise<void>((resolve) => resolvers.set(n, resolve));
    const g1 = gate(1);
    const g2 = gate(2);

    const orderedTool: AnyMcpTool = {
      name: 'ordered',
      description: 'records call order',
      jsonSchema: {
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
        additionalProperties: false,
      },
      inputSchema: z.object({ n: z.number() }).strict(),
      run: async (input: unknown) => {
        const n = (input as { n: number }).n;
        order.push(`start-${n}`);
        await (n === 1 ? g1 : g2);
        order.push(`end-${n}`);
        return {};
      },
    };

    await start(socketPath, {
      tools: new Map([['ordered', orderedTool]]),
      resolveWindowId: (token: string) => (token === 'tok-1' ? 1 : null),
    });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);

    // hello 绑定窗口(tools/call 需 ctx),随后两行 tools/call 在同一 write(同一 data chunk)→
    // 并行实现会在同一循环里同步发起两个 run;串行实现按序逐个执行。
    socket.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: '_continuo/hello',
        params: { windowId: 1, token: 'tok-1' },
      }) +
        '\n' +
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ordered', arguments: { n: 1 } },
        }) +
        '\n' +
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'ordered', arguments: { n: 2 } },
        }) +
        '\n',
    );

    // 第一行处理到 await。串行下第二行尚未开始(被链阻塞);并行下 start-2 也已出现 → 断言失败。
    await vi.waitFor(() => expect(order).toContain('start-1'));
    expect(order).toEqual(['start-1']);

    // 放行第一行 → 第二行才开始,保序。
    resolvers.get(1)!();
    await vi.waitFor(() => expect(order).toContain('start-2'));
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);

    resolvers.get(2)!();
    socket.destroy();
  });

  // race(R111):socket 在 tool call 在途时断开 → ctx.signal abort,且响应不写回死 socket。
  it('R111 在途 tool call 期间 socket 断开 → ctx.signal aborted,响应不写死 socket', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);

    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((r) => {
      releaseRun = r;
    });
    let sawAbort: boolean | null = null;
    const slowTool: AnyMcpTool = {
      name: 'slow',
      description: 'awaits a gate then reports ctx.signal.aborted',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: async (_input: unknown, c: McpCallCtx) => {
        await runGate; // 模拟卡在用户授权 await
        sawAbort = c.signal?.aborted ?? null;
        return {};
      },
    };

    await start(socketPath, {
      tools: new Map([['slow', slowTool]]),
      resolveWindowId: (token: string) => (token === 'tok-1' ? 1 : null),
    });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);
    socket.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: '_continuo/hello',
        params: { windowId: 1, token: 'tok-1' },
      }) +
        '\n' +
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'slow', arguments: {} },
        }) +
        '\n',
    );

    // 等 tool.run 进入 gate(在途),然后断开连接 → server 端 abort 本连接。
    await new Promise((r) => setTimeout(r, 50));
    socket.destroy();
    await new Promise((r) => setTimeout(r, 30));

    releaseRun(); // 放行 run → 复查 ctx.signal
    await vi.waitFor(() => expect(sawAbort).not.toBeNull());
    expect(sawAbort).toBe(true); // 断开后在途 call 的 signal 已 aborted
  });

  // 边界(E1):stdio 残行无上限 → 畸形/恶意客户端发超长无换行输入让 main 进程内存无限累积。
  // 超字节上限须回 parse 错误并断开,不得让工具执行,也不得无限缓冲。
  it('E1 超长无换行输入 → parse 错误 + 断开,不执行工具', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    let toolRan = false;
    const tool: AnyMcpTool = {
      name: 'e1.tool',
      description: 'must not run on oversized line',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => {
        toolRan = true;
        return {};
      },
    };
    await start(socketPath, { tools: new Map([['e1.tool', tool]]) });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);

    // 收响应(parse 错误)与连接关闭。
    const gotError = new Promise<Record<string, unknown> | null>((resolve) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf('\n');
        if (idx >= 0)
          resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
      });
      socket.on('close', () => resolve(null));
    });

    // 1.5MB 无换行单行(> MAX_STDIO_LINE_BYTES=1MB),分两块发模拟累积。
    socket.write('{"jsonrpc":"2.0","id":1,"x":"' + 'A'.repeat(800_000));
    await new Promise((r) => setTimeout(r, 20));
    socket.write('B'.repeat(800_000)); // 累计 >1.6MB 仍无 \n

    const resp = await gotError;
    if (resp !== null) {
      // 回了 JSON-RPC parse 错误(error.code 存在)
      expect(resp).toHaveProperty('error');
    }
    // 无论是先回错误还是直接断开,工具都不得执行,且连接最终关闭。
    await vi.waitFor(() => expect(socket.destroyed).toBe(true), REJECT_CLOSE_WAIT);
    expect(toolRan).toBe(false);
  });

  // 边界(E127,E125 同族):行上限须按真实 UTF-8 字节。CJK 行 length ≤ 1MB 但 byteLength > 1MB,
  // 旧 buf.length 判断会放行/继续累积;新 utf8BytesExceed 按字节拦 → parse 错误 + 断开。
  it('E127 多字节 CJK 大行(byteLength>1MB,length≤1MB)→ 按字节上限断开', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    let toolRan = false;
    const tool: AnyMcpTool = {
      name: 'e127.tool',
      description: 'must not run on oversized multibyte line',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => {
        toolRan = true;
        return {};
      },
    };
    await start(socketPath, { tools: new Map([['e127.tool', tool]]) });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);

    const done = new Promise<void>((resolve) => {
      socket.on('data', () => {}); // 可能先回 parse 错误
      socket.on('close', () => resolve());
    });

    // 400k '中' = 1.2MB UTF-8 字节,length=400k(≤ 1MB code units),无 \n。
    socket.write('中'.repeat(400_000));

    await Promise.race([
      done,
      vi.waitFor(() => expect(socket.destroyed).toBe(true), REJECT_CLOSE_WAIT),
    ]);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true), REJECT_CLOSE_WAIT);
    expect(toolRan).toBe(false);
  });

  // 边界(E214):单 chunk 行数无上限 → 海量极短行(单行不超字节)让 main 为每行挂 promise → CPU/内存
  // 放大。非空行数超 MAX_STDIO_LINES_PER_CHUNK(1024)→ parse error + 断开,不执行工具。
  it('E214 单 chunk 海量极短 JSON 行(超行数预算)→ parse 错误 + 断开,不执行工具', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    let toolRan = false;
    const tool: AnyMcpTool = {
      name: 'e214.tool',
      description: 'must not run on too-many-lines flood',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => {
        toolRan = true;
        return {};
      },
    };
    await start(socketPath, { tools: new Map([['e214.tool', tool]]) });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);

    const done = new Promise<void>((resolve) => {
      socket.on('data', () => {}); // 可能先回 parse 错误
      socket.on('close', () => resolve());
    });

    // 2000 行极短无效 JSON(单行 ~2 字节,均不超字节上限,但行数 > 1024 预算)。
    socket.write('{}\n'.repeat(2000));

    await Promise.race([
      done,
      vi.waitFor(() => expect(socket.destroyed).toBe(true), REJECT_CLOSE_WAIT),
    ]);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true), REJECT_CLOSE_WAIT);
    expect(toolRan).toBe(false);
  });

  // 边界(E214/E218):上限内的空白行(NDJSON 忽略)入链前同步跳过 —— 不挂 promise、不断开。
  // (注:超 MAX_STDIO_LINES_PER_CHUNK 的空行洪流会触发 E218 decoder overflow 断开;此处测上限内 500 空行。)
  it('E214 上限内空白行(500 行 \\n)→ 同步跳过,不断开、不执行工具', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    let toolRan = false;
    const tool: AnyMcpTool = {
      name: 'e214b.tool',
      description: 'must not run on blank-line flood',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => {
        toolRan = true;
        return {};
      },
    };
    await start(socketPath, { tools: new Map([['e214b.tool', tool]]) });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);
    socket.on('data', () => {});

    socket.write('\n'.repeat(500)); // 500 空行(< MAX_STDIO_LINES_PER_CHUNK)→ 跳过,不断开
    await new Promise((r) => setTimeout(r, 40));

    expect(socket.destroyed).toBe(false); // 上限内空行被忽略,连接保持
    expect(toolRan).toBe(false);
    socket.destroy();
  });

  // 边界(E218,E214 下推 decoder):decoder 在 split 处即 cap 行数,空行洪流(> 上限)也触发 overflow
  // 断开(不先 split 全量物化海量空行)。补 E214b 的"超上限空行"路径。
  it('E218 空行洪流(> MAX_STDIO_LINES_PER_CHUNK)→ decoder overflow + 断开', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await start(socketPath, { tools: new Map() });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);
    const done = new Promise<void>((resolve) => {
      socket.on('data', () => {});
      socket.on('close', () => resolve());
    });

    socket.write('\n'.repeat(2000)); // 2000 空行 > 1024 预算 → decoder overflow → 断开

    await Promise.race([
      done,
      vi.waitFor(() => expect(socket.destroyed).toBe(true), REJECT_CLOSE_WAIT),
    ]);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true), REJECT_CLOSE_WAIT);
  });

  // 边界(E233,E227-E232 数量上限族):全局连接数上限。本用户任意进程可反复连 mcp.sock 保持空闲 →
  // 累积 socket/AbortController/Map 条目 + broadcast 线性写。connection 入口超限写错误 + destroy,不入表。
  it('E233 全局连接数到 MAX_STDIO_CLIENTS_GLOBAL → 超限连接收 too many connections + 断开', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await start(socketPath, { tools: new Map() });
    const max = MAX_STDIO_CLIENTS_GLOBAL_FOR_TEST;

    // 建满 max 个连接并保持(不关 → clients.size 停在 max)。
    const sockets: Socket[] = [];
    for (let i = 0; i < max; i++) {
      const s = createConnection(socketPath);
      await waitForConnect(s);
      sockets.push(s);
    }

    // 第 max+1 个:超限 → 收 parse error "too many connections" 并断开。
    const overflow = createConnection(socketPath);
    await waitForConnect(overflow);
    const resp = await waitForLine(overflow);
    expect(resp.error).toBeTruthy();
    expect((resp.error as { message?: string }).message).toContain(
      'too many connections',
    );
    await vi.waitFor(() => expect(overflow.destroyed).toBe(true));

    // 清理:关一个已建连接后,新连接又可建立(计数随 close 释放)。
    sockets[0]!.destroy();
    await vi.waitFor(() => expect(sockets[0]!.destroyed).toBe(true));
    await new Promise((r) => setTimeout(r, 40)); // 等 server close 事件清 clients
    const revived = createConnection(socketPath);
    await waitForConnect(revived);
    // revived 不应立即被断开(还有空位)。
    await new Promise((r) => setTimeout(r, 40));
    expect(revived.destroyed).toBe(false);

    for (const s of sockets) s.destroy();
    revived.destroy();
    overflow.destroy();
  });

  // 安全(W2,Windows 多用户):命名管道默认 DACL 给 Everyone 读、管道名可枚举 —— 其它本机用户只读打开
  // MAX_STDIO_CLIENTS_GLOBAL 次挂着不发数据,即可占满全局连接名额,本用户所有 agent 的 MCP 连接被拒。
  // 首条完整消息超时:连上后限定时间内没收到任何完整的非空行 → 断开。合法客户端连上即发 hello / initialize。
  it('W2 连上后迟迟不发完整消息(含只发残行)→ 首条消息超时断开,释放连接名额', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await start(socketPath);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const idle = createConnection(socketPath);
      await waitForConnect(idle);
      const partial = createConnection(socketPath);
      await waitForConnect(partial);
      partial.write('{"jsonrpc":"2.0"'); // 无换行:不是完整消息
      // 读走数据,才能看到服务端 FIN 并自动关闭(否则暂停模式下 destroyed 永远 false)。
      idle.resume();
      partial.resume();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      vi.advanceTimersByTime(STDIO_FIRST_MESSAGE_TIMEOUT_MS_FOR_TEST - 1);
      expect(idle.destroyed).toBe(false);
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      await vi.waitFor(() => expect(idle.destroyed).toBe(true), REJECT_CLOSE_WAIT);
      await vi.waitFor(() => expect(partial.destroyed).toBe(true), REJECT_CLOSE_WAIT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('W2 连上后及时发出完整消息(hello / initialize)→ 之后长时间空闲也不被断开', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await start(socketPath, { tools: new Map([['owner', ownerTool()]]) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const socket = createConnection(socketPath);
      await waitForConnect(socket);
      // 不用 waitForLine(其 2s 超时也会被 fake):直接等首个响应数据到达,确认服务端已处理首条消息。
      const response = new Promise<void>((resolve) => socket.once('data', () => resolve()));
      socket.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
      );
      await response;
      vi.advanceTimersByTime(STDIO_FIRST_MESSAGE_TIMEOUT_MS_FOR_TEST * 10);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 40));
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
