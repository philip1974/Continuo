import { describe, expect, it, vi } from 'vitest';
import {
  pickArgvFolders,
  isWithinStartupPathLimit,
  MAX_STARTUP_DIRS,
  MAX_STARTUP_DIR_PATH_LEN,
} from '../../../electron/main/services/cli-args.service';

describe('pickArgvFolders', () => {
  it('packaged mode returns existing absolute folder argv entries', () => {
    const isDir = vi.fn((p: string) => p === '/Users/foo/proj');

    expect(
      pickArgvFolders(
        ['/Applications/Continuo.app/Contents/MacOS/Continuo', '/Users/foo/proj'],
        isDir,
        { skipFirstArg: false },
      ),
    ).toEqual(['/Users/foo/proj']);
  });

  it('dev mode skips argv[1] and keeps the dragged folder', () => {
    const isDir = vi.fn((p: string) => p === '/Users/foo/proj');

    expect(
      pickArgvFolders(['electron', '.', '/Users/foo/proj'], isDir, {
        skipFirstArg: true,
      }),
    ).toEqual(['/Users/foo/proj']);
    expect(isDir).not.toHaveBeenCalledWith('.');
  });

  it('drops non-existing paths', () => {
    const isDir = vi.fn((_p: string) => false);

    expect(
      pickArgvFolders(['Continuo', '/Users/foo/nope'], isDir, {
        skipFirstArg: false,
      }),
    ).toEqual([]);
  });

  it('dedupes duplicate folders preserving first-seen order', () => {
    const isDir = vi.fn((_p: string) => true);

    expect(
      pickArgvFolders(
        ['Continuo', '/Users/foo/proj', '/Users/foo/proj'],
        isDir,
        { skipFirstArg: false },
      ),
    ).toEqual(['/Users/foo/proj']);
  });

  it('skipAll returns empty even when argv has a folder', () => {
    const isDir = vi.fn((_p: string) => true);

    expect(
      pickArgvFolders(['Continuo', '/Users/foo/proj'], isDir, {
        skipFirstArg: false,
        skipAll: true,
      }),
    ).toEqual([]);
    expect(isDir).not.toHaveBeenCalled();
  });

  it('drops relative paths before checking isExistingDir', () => {
    const isDir = vi.fn((_p: string) => true);

    expect(
      pickArgvFolders(['Continuo', 'relative/path'], isDir, {
        skipFirstArg: false,
      }),
    ).toEqual([]);
    expect(isDir).not.toHaveBeenCalled();
  });

  it('keeps mixed absolute folders, drops relative paths, and dedupes', () => {
    const isDir = vi.fn((p: string) => p === '/abs/a' || p === '/abs/b');

    expect(
      pickArgvFolders(
        ['Continuo', '/abs/a', 'relative', '/abs/b', '/abs/a'],
        isDir,
        { skipFirstArg: false },
      ),
    ).toEqual(['/abs/a', '/abs/b']);
  });

  // 边界(E58,E55 外部输入族):启动目录数封顶 + 超长路径先跳过(不 stat),挡畸形命令行/file-open
  // 大量/超长路径冷启动同步 I/O + 批量开窗。
  describe('E58 · 数量/路径长度上限', () => {
    it('目录数超上限 → 封顶到 MAX_STARTUP_DIRS', () => {
      const isDir = vi.fn(() => true);
      const many = Array.from(
        { length: MAX_STARTUP_DIRS + 20 },
        (_, i) => `/abs/d${i}`,
      );
      const r = pickArgvFolders(['Continuo', ...many], isDir, {
        skipFirstArg: false,
      });
      expect(r).toHaveLength(MAX_STARTUP_DIRS);
      // 封顶后停止收集 → 不再对超出部分 isExistingDir(同步 stat)
      expect(isDir.mock.calls.length).toBeLessThanOrEqual(MAX_STARTUP_DIRS);
    });

    it('超长路径 → 跳过且不调 isExistingDir(不 stat)', () => {
      const isDir = vi.fn(() => true);
      const longPath = '/' + 'x'.repeat(MAX_STARTUP_DIR_PATH_LEN);
      const r = pickArgvFolders(['Continuo', longPath, '/abs/ok'], isDir, {
        skipFirstArg: false,
      });
      expect(r).toEqual(['/abs/ok']);
      expect(isDir).not.toHaveBeenCalledWith(longPath); // 超长不 stat
    });
  });

  // 边界(E192,E176/E189 有界迭代族):pickArgvFolders 索引遍历原 argv,不 argv.slice(start)——
  // slice 在循环截断前就把尾部全量复制,畸形超长 process.argv 冷启动产生不必要内存峰值。
  describe('E192 · 不全量复制 argv 尾部(索引遍历)', () => {
    it('实现不调用 argv.slice(凑满即 break,不物化新数组)', () => {
      const isDir = vi.fn(() => true);
      const real = ['Continuo', '/abs/a', '/abs/b'];
      // Proxy:访问 .slice 即抛 —— 若实现仍 argv.slice(start) 立即失败。
      const guarded = new Proxy(real, {
        get(target, prop, recv) {
          if (prop === 'slice') {
            throw new Error('E192 regression: pickArgvFolders 不应 slice argv');
          }
          return Reflect.get(target, prop, recv);
        },
      }) as unknown as readonly string[];
      expect(
        pickArgvFolders(guarded, isDir, { skipFirstArg: false }),
      ).toEqual(['/abs/a', '/abs/b']);
    });

    it('索引遍历仍尊重 start 偏移(skipFirstArg 跳过 argv[0..1])', () => {
      const isDir = vi.fn(() => true);
      // dev 模式 start=2:argv[0]=electron / argv[1]=. 都跳过,只收 argv[2..]
      expect(
        pickArgvFolders(['electron', '/abs/skipped-by-start', '/abs/keep'], isDir, {
          skipFirstArg: true,
        }),
      ).toEqual(['/abs/keep']);
      expect(isDir).not.toHaveBeenCalledWith('/abs/skipped-by-start');
    });
  });

  // 边界(E59):isWithinStartupPathLimit 是 argv / open-file 缓冲 / 运行期 open-file 三处共用的
  // string + 长度守卫(运行期 openPathInNewWindow 复用它,statSync 前过滤超长路径)。
  describe('E59 · isWithinStartupPathLimit', () => {
    it('正常路径 → true', () => {
      expect(isWithinStartupPathLimit('/Users/foo/proj')).toBe(true);
    });
    it('空串 / 非字符串 → false', () => {
      expect(isWithinStartupPathLimit('')).toBe(false);
      expect(isWithinStartupPathLimit(123 as never)).toBe(false);
      expect(isWithinStartupPathLimit(null as never)).toBe(false);
    });
    it('超长(>上限)→ false;恰好上限 → true', () => {
      expect(isWithinStartupPathLimit('x'.repeat(MAX_STARTUP_DIR_PATH_LEN))).toBe(
        true,
      );
      expect(
        isWithinStartupPathLimit('x'.repeat(MAX_STARTUP_DIR_PATH_LEN + 1)),
      ).toBe(false);
    });
  });
});
