import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// P3 资源回收一致性回归(第七 session R3):SIGTERM→SIGKILL 的内层 1s grace timer
// 必须 unref,否则超时触发后即便子进程已死,该 timer 仍把 event loop 多撑 1s
// → 关窗/退出延迟退出。forceKillStream(plugin-shell-stream) 与 shell.service 早已
// unref grace timer,但 START 超时路径(plugin-shell-stream)与 runGit(plugins.service)
// 的内层 SIGKILL timer 此前漏了 unref(「unref 模式未传播到兄弟 timer」)。
//
// 这是 inline 内层 timer 行为,无法干净单测(event-loop 存活),用静态结构守卫
// (popout-consumers 风格):断言每个 SIGKILL grace setTimeout 都被捕获成 const 且 unref。
const ROOT = join(__dirname, '..', '..', '..');

const FILES = [
  'electron/main/services/plugin-shell-stream.service.ts',
  'electron/main/services/plugins.service.ts',
];

/** 找出文件里所有 body 含 child.kill('SIGKILL') 的 setTimeout 调用,返回其起始片段。 */
function sigkillGraceTimerSlices(src: string): string[] {
  const slices: string[] = [];
  const re = /setTimeout\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // 取该 setTimeout 起点后约 200 字符窗口,判断其 body 是否含 SIGKILL。
    const window = src.slice(m.index, m.index + 220);
    if (window.includes("child.kill('SIGKILL')")) {
      // 取该 setTimeout 之前约 40 字符,判断是否被 `const xxx =` 捕获。
      const prefix = src.slice(Math.max(0, m.index - 40), m.index);
      slices.push(prefix + '⟦setTimeout⟧');
    }
  }
  return slices;
}

describe('49 · SIGKILL grace timer 必须 unref(防延迟退出)', () => {
  for (const rel of FILES) {
    it(`${rel}:每个 SIGKILL grace setTimeout 被 const 捕获且文件内有 unref`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      const slices = sigkillGraceTimerSlices(src);
      // 确实存在 SIGKILL grace timer(否则守卫形同虚设)。
      expect(slices.length).toBeGreaterThanOrEqual(1);
      // 每个都必须被 `const <id> =` 捕获(裸 setTimeout 无法 unref)。
      for (const s of slices) {
        expect(s).toMatch(/const\s+\w+\s*=\s*⟦setTimeout⟧$/);
      }
      // 文件内存在 unref 调用(捕获后必须 unref)。
      expect(src).toMatch(/\.unref\(\)/);
    });
  }
});
