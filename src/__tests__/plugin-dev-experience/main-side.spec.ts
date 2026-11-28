// BDD: plugin-dev-experience(见同目录 README)—— 主进程侧:跳过原因带回、source map 内联、语法检查不执行、
// 文件监视广播新出现 / 无效的插件目录。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkModuleSyntax,
  createPluginsWatcher,
  inlinePluginSourceMap,
  listPluginDirs,
  parseSyntaxCheckOutput,
  readPluginMainByDir,
  pluginManifestHash,
} from '../../../electron/main/services/plugins.service';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pdx-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function plugin(dir: string, manifest: object | string, files: Record<string, string> = { 'main.js': '' }): string {
  const p = join(tmp, dir);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(p, name, '..'), { recursive: true });
    writeFileSync(join(p, name), text);
  }
  return p;
}

describe('LIST_DIRS 带回跳过原因(无效插件不再静默消失)', () => {
  it('目录名 ≠ manifest.id / main 入口不存在 → includeSkipped 时带结构化 skip;默认列举仍不含', async () => {
    plugin('good', { id: 'good', name: 'G', version: '1.0.0' });
    plugin('wrongname', { id: 'com.x.real', name: 'W', version: '1.0.0' });
    plugin('nodist', { id: 'nodist', name: 'N', version: '1.0.0', main: 'dist/main.js' }, {});

    const all = await listPluginDirs(tmp, { includeSkipped: true });
    const byId = new Map(all.map((d) => [d.id, d]));
    expect(byId.get('good')).not.toHaveProperty('skip');
    expect(byId.get('wrongname')).toMatchObject({
      skip: { code: 'PLUGIN_DIR_NAME_MISMATCH', params: { dir: 'wrongname', declaredId: 'com.x.real' } },
    });
    expect(byId.get('nodist')).toMatchObject({
      skip: { code: 'PLUGIN_MAIN_UNAVAILABLE', params: { main: 'dist/main.js', reason: 'unreachable' } },
    });
    expect(byId.get('nodist')).not.toHaveProperty('manifestHash'); // 不可激活:没有拉 main 的令牌

    expect((await listPluginDirs(tmp)).map((d) => d.id)).toEqual(['good']);
  });
});

describe('相对 sourceMappingURL 内联为 data URL(只读插件目录内的文件)', () => {
  const map = JSON.stringify({ version: 3, sources: ['../src/index.ts'], sourcesContent: ['x'], mappings: 'AAAA' });

  it('入口末尾的相对 map → 换成 base64 data URL,其余源码不变', async () => {
    const dir = plugin('p', { id: 'p', name: 'P', version: '1.0.0' }, {
      'dist/main.js': 'export default 1;\n//# sourceMappingURL=main.js.map\n',
      'dist/main.js.map': map,
    });
    const out = await inlinePluginSourceMap(dir, join(dir, 'dist/main.js'), 'export default 1;\n//# sourceMappingURL=main.js.map\n');
    expect(out.startsWith('export default 1;\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,')).toBe(true);
    const b64 = out.trim().split('base64,')[1]!;
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(map);
  });

  it('READ_MAIN_BY_DIR 走内联(inlineSourceMap),不带选项的读取保持原文', async () => {
    const manifest = { id: 'p', name: 'P', version: '1.0.0' };
    plugin('p', manifest, { 'main.js': 'export default 1;\n//# sourceMappingURL=main.js.map', 'main.js.map': map });
    const hash = pluginManifestHash(JSON.stringify(manifest));
    expect(await readPluginMainByDir(tmp, 'p', hash)).toBe('export default 1;\n//# sourceMappingURL=main.js.map');
    expect(await readPluginMainByDir(tmp, 'p', hash, { inlineSourceMap: true })).toContain('sourceMappingURL=data:');
  });

  it('越界(../ 或指向目录外的链接)/ data: / 绝对地址 / 不存在 → 原样不动', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pdx-out-'));
    try {
      writeFileSync(join(outside, 'secret.map'), map);
      const dir = plugin('p', { id: 'p', name: 'P', version: '1.0.0' }, { 'main.js': '' });
      symlinkSync(join(outside, 'secret.map'), join(dir, 'link.map'));
      const main = join(dir, 'main.js');
      for (const url of ['../../secret.map', 'link.map', 'data:application/json;base64,e30=', '/etc/passwd', 'https://x/y.map', 'nope.map']) {
        const src = `x\n//# sourceMappingURL=${url}\n`;
        expect(await inlinePluginSourceMap(dir, main, src)).toBe(src);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('入口语法检查:给出行列号且不执行插件代码', () => {
  it('语法错误 → 1 起的行列号 + V8 消息', async () => {
    const r = await checkModuleSyntax('const a = 1;\nexport default class X {\n  m() { let = = 2; }\n}\n');
    expect(r).toMatchObject({ line: 3 });
    expect(r!.column).toBeGreaterThan(1);
    expect(r!.message.length).toBeGreaterThan(0);
  });

  it('合法模块 → null,且顶层代码没有被执行(无害探针:写文件)', async () => {
    const probe = join(tmp, 'executed.txt');
    const src = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(probe)}, 'ran');\nexport default 1;\n`;
    expect(await checkModuleSyntax(src)).toBeNull();
    expect(existsSync(probe)).toBe(false);
  });

  it('有语法错误的模块同样不执行(错误在后面,前面的语句不跑)', async () => {
    const probe = join(tmp, 'executed2.txt');
    const src = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(probe)}, 'ran');\nlet = = 1;\n`;
    expect(await checkModuleSyntax(src)).toMatchObject({ line: 3 });
    expect(existsSync(probe)).toBe(false);
  });

  it('parseSyntaxCheckOutput:caret 指示列;不是语法错误输出 → null', () => {
    expect(parseSyntaxCheckOutput('[stdin]:2\n  let = = 1;\n      ^\n\nSyntaxError: Unexpected token \'=\'\n')).toEqual({
      line: 2,
      column: 7,
      message: "Unexpected token '='",
    });
    expect(parseSyntaxCheckOutput('Error: something else')).toBeNull();
  });

  it('长行(压缩成一行的打包产物):出错位置远在 64 KiB 之后 → 仍给出准确行号,不编造第 1 列', async () => {
    const prefix = 'var a = 1;'.repeat(20_000); // 200,000 字符:Node 的 `^` 行画不到这么远,stderr 管道也只留前 64 KiB
    const r = await checkModuleSyntax(`// header\n${prefix}let = = 1;\n`);
    expect(r).toMatchObject({ line: 2 });
    expect(r).not.toHaveProperty('column');
    // 位置在 `^` 行能画到的范围内(约 1020 列以内)→ 列号照给
    const near = 'var a = 1;'.repeat(50);
    const r2 = await checkModuleSyntax(`${near}let = = 1;\n`);
    const short = await checkModuleSyntax('let = = 1;\n');
    expect(r2).toEqual({ line: 1, column: near.length + short!.column!, message: short!.message });
  });

  it('找不到 `^` 指示行(输出被截断 / 格式不同)→ 只给行号,不编造第 1 列', () => {
    expect(parseSyntaxCheckOutput("[stdin]:4\nlet = = 1;\n\nSyntaxError: Unexpected token '='\n")).toEqual({
      line: 4,
      message: "Unexpected token '='",
    });
    expect(parseSyntaxCheckOutput("[stdin]:4\nlet = = 1;\n   x^\n\nSyntaxError: Unexpected token '='\n")).not.toHaveProperty('column');
    // 出错行原文是长行、其后的输出丢失 → 仍给行号(消息空,renderer 用 import 的报错);短行却没有 SyntaxError 行 → 不认
    expect(parseSyntaxCheckOutput(`[stdin]:7\n${'x'.repeat(70_000)}`)).toEqual({ line: 7, message: '' });
    expect(parseSyntaxCheckOutput('[stdin]:7\nfoo\n')).toBeNull();
  });
});

describe('文件监视:运行中新放入 / 无效 / 修好的插件目录广播', () => {
  it('首轮之后新出现的插件 id → 广播(运行中放入的插件无需重载窗口即登记)', async () => {
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    plugin('late', { id: 'late', name: 'L', version: '1.0.0' });
    await w.tick();
    await w.tick();
    expect(fn.mock.calls).toEqual([['late']]);
  });

  it('manifest 不是合法 JSON 的目录:出现、改动、修好各广播一次(按目录名)', async () => {
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    const dir = plugin('broken', '{ nope');
    await w.tick(); // 出现
    writeFileSync(join(dir, 'manifest.json'), '{ still nope');
    const t = Date.now() / 1000 + 10;
    utimesSync(join(dir, 'manifest.json'), t, t);
    await w.tick(); // 改动(仍无效)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'broken', name: 'B', version: '1.0.0' }));
    await w.tick(); // 修好:新出现的合法 id(与目录名同名,同一轮只广播一次)
    await w.tick();
    expect(fn.mock.calls).toEqual([['broken'], ['broken'], ['broken']]);
  });

  it('已监视插件的 main 被删(入口不可用)→ 广播该 id;恢复后再广播', async () => {
    plugin('a', { id: 'a', name: 'A', version: '1.0.0' }, { 'main.js': 'v1' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    rmSync(join(tmp, 'a', 'main.js'));
    await w.tick();
    expect(fn.mock.calls).toEqual([['a']]);
    writeFileSync(join(tmp, 'a', 'main.js'), 'v1');
    await w.tick();
    await w.tick();
    expect(fn.mock.calls).toEqual([['a'], ['a']]);
  });

  it('schema 错 / 版本过高 / 目录名不一致的目录被删除 → 各广播一次(renderer 据此移除无效行)', async () => {
    plugin('schema', { id: 'schema', name: 'S', version: 'not-semver' });
    plugin('newer', { id: 'newer', name: 'N', version: '1.0.0', minLMVersion: '99.0.0' });
    plugin('wrongname', { id: 'com.x.real', name: 'W', version: '1.0.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    for (const d of ['schema', 'newer', 'wrongname']) rmSync(join(tmp, d), { recursive: true, force: true });
    await w.tick();
    await w.tick();
    expect([...fn.mock.calls].sort()).toEqual([['com.x.real'], ['newer'], ['schema']]);
  });
});
