// 安全(Linux AppImage 老用户迁移):fb7dca2d 之前「复制 MCP 配置」给出的命令指向 `/tmp/.mount_*` 临时挂载路径,
// 执行过 `claude mcp add` 的用户 ~/.claude.json 里仍持久保存该路径 —— Continuo 退出后同机其他用户可在共享 /tmp
// 抢注同名目录放同名脚本,受害者下次启动 Claude Code 即以自身身份执行。新版只改了之后展示的命令,存量配置仍危险。
// 契约:Linux 启动时**只读**检查 ~/.claude.json(不存在 / 解析失败 / 超大 → 跳过),命中「command/args 指向
// continuo-mcp-stdio.mjs 且位于不稳定位置」的条目 → 提示用户移除并改用新命令;绝不修改 ~/.claude.json。
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_JSON_MAX_BYTES,
  findLegacyUnstableClaudeEntries,
  findUnstableStdioCliEntries,
  warnIfLegacyUnstableClaudeConfig,
} from '../services/mcp-stdio-legacy-config';

const roots: string[] = [];
afterEach(async () => {
  for (const d of roots.splice(0)) await rm(d, { recursive: true, force: true });
});
async function home(content?: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-legacy-cfg-'));
  roots.push(d);
  if (content !== undefined) await writeFile(join(d, '.claude.json'), content);
  return d;
}

const UNSTABLE = '/tmp/.mount_ContinAB12/resources/continuo-mcp-stdio.mjs';
const STABLE = '/home/u/.config/Continuo/bin/continuo-mcp-stdio.mjs';

describe('findUnstableStdioCliEntries', () => {
  it('顶层(user scope)与 projects.*(local scope,claude mcp add 默认)里指向临时路径的条目都命中', () => {
    const cfg = {
      mcpServers: { continuo: { type: 'stdio', command: UNSTABLE, args: [] } },
      projects: {
        '/home/u/repo': { mcpServers: { co2: { command: 'node', args: [UNSTABLE] } } },
        '/home/u/other': { mcpServers: { ok: { command: STABLE } } },
      },
    };
    expect(findUnstableStdioCliEntries(cfg, '/tmp').sort()).toEqual(['co2', 'continuo']);
  });

  it('TMPDIR 被改时 /var/tmp、/dev/shm、任意 .mount_ 段仍命中', () => {
    const cfg = {
      mcpServers: {
        a: { command: '/var/tmp/x/continuo-mcp-stdio.mjs' },
        b: { command: '/dev/shm/x/continuo-mcp-stdio.mjs' },
        c: { command: '/run/user/1000/.mount_Xy/resources/continuo-mcp-stdio.mjs' },
      },
    };
    expect(findUnstableStdioCliEntries(cfg, '/home/u/tmp').sort()).toEqual(['a', 'b', 'c']);
  });

  it('稳定路径 / 其它脚本 / 畸形结构不命中,也不抛', () => {
    expect(findUnstableStdioCliEntries({ mcpServers: { x: { command: STABLE } } }, '/tmp')).toEqual([]);
    expect(findUnstableStdioCliEntries({ mcpServers: { x: { command: '/tmp/other.mjs' } } }, '/tmp')).toEqual([]);
    for (const bad of [null, 1, 'x', [], { mcpServers: 1 }, { mcpServers: { x: null } }, { projects: [1] },
      { projects: { p: null } }, { mcpServers: { x: { command: 1, args: 'no' } } }]) {
      expect(findUnstableStdioCliEntries(bad, '/tmp')).toEqual([]);
    }
  });
});

describe('findLegacyUnstableClaudeEntries(只读、容错)', () => {
  it('非 Linux → 不读,返回空', async () => {
    const h = await home(JSON.stringify({ mcpServers: { continuo: { command: UNSTABLE } } }));
    expect(await findLegacyUnstableClaudeEntries({ homeDir: h, platform: 'darwin', tmpDir: '/tmp' })).toEqual([]);
  });

  it('Linux 命中条目;文件内容与 mtime 均不变(只读)', async () => {
    const text = JSON.stringify({ mcpServers: { continuo: { command: UNSTABLE } } });
    const h = await home(text);
    const before = await stat(join(h, '.claude.json'));
    expect(await findLegacyUnstableClaudeEntries({ homeDir: h, platform: 'linux', tmpDir: '/tmp' })).toEqual([
      'continuo',
    ]);
    expect(await readFile(join(h, '.claude.json'), 'utf8')).toBe(text);
    expect((await stat(join(h, '.claude.json'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('不存在 / 解析失败 / 超大 → 跳过返回空,不抛', async () => {
    expect(await findLegacyUnstableClaudeEntries({ homeDir: await home(), platform: 'linux', tmpDir: '/tmp' })).toEqual([]);
    expect(
      await findLegacyUnstableClaudeEntries({ homeDir: await home('{not json'), platform: 'linux', tmpDir: '/tmp' }),
    ).toEqual([]);
    const big = JSON.stringify({ mcpServers: { continuo: { command: UNSTABLE } }, pad: 'x'.repeat(CLAUDE_JSON_MAX_BYTES) });
    expect(await findLegacyUnstableClaudeEntries({ homeDir: await home(big), platform: 'linux', tmpDir: '/tmp' })).toEqual([]);
  });
});

describe('warnIfLegacyUnstableClaudeConfig', () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ''}`;

  it('命中 → 弹警告(含条目名与移除指引);选「复制新命令」写剪贴板', async () => {
    const h = await home(JSON.stringify({ mcpServers: { continuo: { command: UNSTABLE } } }));
    const show = vi.fn(async () => ({ response: 0 }));
    const writeClipboard = vi.fn();
    const warned = await warnIfLegacyUnstableClaudeConfig({
      homeDir: h,
      platform: 'linux',
      tmpDir: '/tmp',
      claudeAddCommand: `claude mcp add --transport stdio continuo -- ${STABLE}`,
      t,
      show,
      writeClipboard,
    });
    expect(warned).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    const opts = (show.mock.calls[0] as unknown as [{ type: string; detail: string; buttons: string[] }])[0];
    expect(opts.type).toBe('warning');
    expect(opts.detail).toContain('continuo');
    expect(opts.buttons).toHaveLength(2);
    expect(writeClipboard).toHaveBeenCalledWith(`claude mcp add --transport stdio continuo -- ${STABLE}`);
  });

  it('无可用新命令 → 只有确认按钮,不写剪贴板', async () => {
    const h = await home(JSON.stringify({ mcpServers: { continuo: { command: UNSTABLE } } }));
    const show = vi.fn(async () => ({ response: 0 }));
    const writeClipboard = vi.fn();
    await warnIfLegacyUnstableClaudeConfig({ homeDir: h, platform: 'linux', tmpDir: '/tmp', t, show, writeClipboard });
    const opts = (show.mock.calls[0] as unknown as [{ buttons: string[] }])[0];
    expect(opts.buttons).toHaveLength(1);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it('未命中 / 非 Linux → 不弹', async () => {
    const show = vi.fn(async () => ({ response: 0 }));
    const h = await home(JSON.stringify({ mcpServers: { continuo: { command: STABLE } } }));
    expect(
      await warnIfLegacyUnstableClaudeConfig({ homeDir: h, platform: 'linux', tmpDir: '/tmp', t, show, writeClipboard: vi.fn() }),
    ).toBe(false);
    const h2 = await home(JSON.stringify({ mcpServers: { continuo: { command: UNSTABLE } } }));
    await warnIfLegacyUnstableClaudeConfig({ homeDir: h2, platform: 'win32', tmpDir: '/tmp', t, show, writeClipboard: vi.fn() });
    expect(show).not.toHaveBeenCalled();
  });

  describe('条目名来自 ~/.claude.json(不可信):显示前净化,拼进命令前校验', () => {
    async function detailParams(names: string[]): Promise<{ names: string; first: string }> {
      const servers = Object.fromEntries(names.map((n) => [n, { command: UNSTABLE }]));
      const h = await home(JSON.stringify({ mcpServers: servers }));
      let captured: Record<string, string | number> | undefined;
      const tc = (key: string, params?: Record<string, string | number>) => {
        if (key === 'dialog.mcp_legacy_config.detail') captured = params;
        return key;
      };
      await warnIfLegacyUnstableClaudeConfig({
        homeDir: h, platform: 'linux', tmpDir: '/tmp', t: tc, show: vi.fn(async () => ({ response: 1 })), writeClipboard: vi.fn(),
      });
      return captured as { names: string; first: string };
    }
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it('C0 控制字符与 DEL 替换为 ?(\\n 不能在框内伪造行)', async () => {
      const p = await detailParams(['evil\n\nRun: curl x|sh\r\u0007\u001b[2J\u007f']);
      // eslint-disable-next-line no-control-regex
      expect(p.names).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(p.names).toBe('evil??Run: curl x|sh???[2J?');
    });

    it('超长名按 code point 截断,不切开代理对', async () => {
      const p = await detailParams(['a'.repeat(63) + '😀😀tail']);
      expect(p.names).not.toMatch(LONE_SURROGATE);
      expect(p.names).toBe('a'.repeat(63) + '😀…');
    });

    it('普通名原样拼进 claude mcp remove;含 shell 元字符 / 空白 / 被截断 → 改用通用占位 <name>', async () => {
      expect((await detailParams(['continuo'])).first).toBe('continuo');
      expect((await detailParams(['my-server_1.x'])).first).toBe('my-server_1.x');
      expect((await detailParams(['x; rm -rf ~'])).first).toBe('<name>');
      expect((await detailParams(['$(id)'])).first).toBe('<name>');
      expect((await detailParams(['a\nb'])).first).toBe('<name>');
      expect((await detailParams(['a'.repeat(65)])).first).toBe('<name>');
    });
  });

  it('弹框失败不抛(启动路径 fire-and-forget)', async () => {
    const h = await home(JSON.stringify({ mcpServers: { continuo: { command: UNSTABLE } } }));
    const show = vi.fn(async () => {
      throw new Error('no display');
    });
    await expect(
      warnIfLegacyUnstableClaudeConfig({ homeDir: h, platform: 'linux', tmpDir: '/tmp', t, show, writeClipboard: vi.fn() }),
    ).resolves.toBe(true);
  });
});
