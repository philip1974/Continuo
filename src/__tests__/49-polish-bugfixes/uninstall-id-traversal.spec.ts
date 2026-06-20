import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uninstallPlugin } from '../../../electron/main/services/plugins.service';

// P1 安全回归(第七 session R1):uninstallPlugin 此前用裸正则 `^[a-z0-9._-]+$`
// 而非 isSafePluginId 校验 id —— 该正则**放行纯点段 `..`**。
//   uninstallPlugin(baseDir, '..')
//     → path.join(baseDir, '..') = baseDir 的父目录
//     → rm(targetDir, { recursive:true, force:true }) = rm -rf 父目录
// install 侧(manifest.id)早已用 isSafePluginId 拒 `.`/`..`,uninstall 是漏改的
// 兄弟入口(「helper 建了未传播到所有调用点」本仓最高频缺陷类)。
//
// 既有 plugins-service.spec「uninstallPlugin · id 含非法字符」只测 `../etc/passwd`
// (含 `/` 被正则拒)给了虚假信心,从未测纯 `..`。本 spec 锁死纯点段穿越。
describe('49 · uninstallPlugin 拒绝纯点段路径穿越', () => {
  let root: string; // 模拟 baseDir 的父目录
  let baseDir: string; // 插件目录

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'continuo-uninstall-traversal-'));
    baseDir = join(root, 'plugins');
    mkdirSync(baseDir, { recursive: true });
    // 父目录(root)里放一个"无辜文件",代表用户其它数据;一旦穿越 rm 它会消失。
    writeFileSync(join(root, 'precious.txt'), 'do-not-delete', 'utf-8');
    // baseDir 里放一个兄弟目录(sibling),代表 baseDir 自身被 rm 时会消失。
    mkdirSync(join(baseDir, 'sibling'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('id=".." → INVALID_ID,绝不 rm baseDir 的父目录', async () => {
    await expect(uninstallPlugin(baseDir, '..')).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
    // 父目录及其内容必须完好(穿越被挡)。
    expect(existsSync(join(root, 'precious.txt'))).toBe(true);
    expect(existsSync(baseDir)).toBe(true);
    expect(existsSync(join(baseDir, 'sibling'))).toBe(true);
  });

  it('id="." → INVALID_ID,绝不 rm baseDir 自身', async () => {
    await expect(uninstallPlugin(baseDir, '.')).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
    expect(existsSync(baseDir)).toBe(true);
    expect(existsSync(join(baseDir, 'sibling'))).toBe(true);
  });

  it('正常 id 仍按 NOT_INSTALLED 走(回归不误伤合法路径)', async () => {
    await expect(uninstallPlugin(baseDir, 'com.legit')).rejects.toMatchObject({
      code: 'NOT_INSTALLED',
    });
  });
});
