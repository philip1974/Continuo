import { useEffect, useRef, useState } from 'react';
import { coApi } from '@/lib/co-api';
import { debounce } from '@/lib/debounce';
import { isSameOrInsidePath, pathEquals } from '@/lib/path-cross';
import { useEditorStore } from '@/stores/editor.store';
import { buildGitDecorationIndex, type GitDecorationIndex } from '../git-decorations';

/** 文件变化 / 保存 / 窗口获焦后的刷新防抖;持续变化(如构建输出)下至多每 2s 一次。 */
export const GIT_REFRESH_DEBOUNCE_MS = 300;
export const GIT_REFRESH_MAX_WAIT_MS = 2000;

/** 有 tab 的已落盘内容变了(保存 / 外部重载):按位置比对同一 tab,O(tab 数)。 */
function savedSomething(
  tabs: readonly { id: string; originalContent: string }[],
  prev: readonly { id: string; originalContent: string }[],
): boolean {
  if (tabs === prev) return false;
  for (let i = 0; i < tabs.length; i++) {
    const a = tabs[i]!;
    const b = prev[i];
    if (b !== undefined && a.id === b.id && a.originalContent !== b.originalContent) return true;
  }
  return false;
}

/**
 * 资源管理器 git 状态(VSCode git 扩展的 status 刷新同思路):挂载 / 换根时取一次;工作区根内的 fs 变化(复用资源管理器
 * 的 fs watch 广播,含仅内容变化)、编辑器保存、窗口获焦后防抖刷新。单飞:在途时再触发只记一次,完成后补跑。
 * 侧栏隐藏期间不刷新,只记脏,再次显示时补一次。enabled=false(装饰全关)→ 不查询、返回 null。
 * 非仓库 / 未装 git / 失败 → null(静默)。git 在 main 异步执行(超时 + 并发上限),这里只建索引。
 * BDD: src/__tests__/explorer-git-decorations/
 */
export function useGitStatus(root: string, enabled: boolean, visible: boolean): GitDecorationIndex | null {
  const [state, setState] = useState<{ root: string; index: GitDecorationIndex | null }>({ root, index: null });

  const [refreshKey, setRefreshKey] = useState(0);
  const [dirtyWhileHidden, setDirtyWhileHidden] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    let rerun = false;
    const run = (): void => {
      if (disposed) return;
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          const r = await coApi.git.status();
          if (disposed || !r.ok) return;
          if (r.data === null) setState({ root, index: null });
          else if (pathEquals(r.data.root, root)) setState({ root, index: buildGitDecorationIndex(r.data.entries) });
        } catch {
          // 静默:git 装饰是增强信息,取不到就不显示(保留上一份)
        } finally {
          inFlight = false;
          if (rerun && !disposed) {
            rerun = false;
            run();
          }
        }
      })();
    };
    const debounced = debounce(
      () => {
        if (!visibleRef.current) {
          setDirtyWhileHidden(true);
          return;
        }
        run();
      },
      GIT_REFRESH_DEBOUNCE_MS,
      { maxWait: GIT_REFRESH_MAX_WAIT_MS },
    );
    run();
    const unsubFs = coApi.fs.onDirChanged((path) => {
      if (isSameOrInsidePath(root, path)) debounced();
    });
    const unsubEditor = useEditorStore.subscribe((s, prev) => {
      if (savedSomething(s.tabs, prev.tabs)) debounced();
    });
    window.addEventListener('focus', debounced);
    return () => {
      disposed = true;
      debounced.cancel();
      unsubFs();
      unsubEditor();
      window.removeEventListener('focus', debounced);
    };
  }, [root, enabled, refreshKey]);

  // 侧栏重新显示:隐藏期间有过变化 → 重新取一次(经 refreshKey 重跑上面的 effect)。
  useEffect(() => {
    if (!visible || !dirtyWhileHidden) return;
    setDirtyWhileHidden(false);
    setRefreshKey((k) => k + 1);
  }, [visible, dirtyWhileHidden]);

  if (!enabled || state.root !== root) return null;
  return state.index;
}
