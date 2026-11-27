import { useEffect, useRef, useSyncExternalStore } from 'react';
import { coApi } from '@/lib/co-api';
import { debounce, type DebouncedFn } from '@/lib/debounce';
import { isSameOrInsidePath, pathEquals } from '@/lib/path-cross';
import { useEditorStore } from '@/stores/editor.store';
import { buildGitDecorationIndex, type GitDecorationIndex } from '../git-decorations';

/** 文件变化 / 保存 / 窗口获焦后的刷新防抖;持续变化(如构建输出)下至多每 2s 一次。 */
export const GIT_REFRESH_DEBOUNCE_MS = 300;
export const GIT_REFRESH_MAX_WAIT_MS = 2000;
/**
 * main 回 STALE(换根时本 effect 早于 App 的 window:notify-root 跑,main 还按旧根 / 未登记)→ 隔这么久重试,至多这么多次
 *(根始终登记不上,如 notify-root 被拒,就停;之后的 fs 变化 / 获焦照常触发查询)。
 */
export const GIT_STALE_RETRY_MS = 100;
export const GIT_STALE_RETRY_MAX = 30;

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

/** 一个使用方(资源管理器 / 某编辑器组的 tab 栏 / 搜索视图)。visible=false 的使用方不需要后台刷新。 */
interface Consumer {
  visible: boolean;
}

/** 某工作区根的共享 git 状态:查询、刷新监听、快照。随首个使用方登记建立,最后一个离开即销毁。 */
interface Source {
  readonly root: string;
  readonly consumers: Set<Consumer>;
  index: GitDecorationIndex | null;
  /** 没有可见使用方期间发生过变化:任一使用方再次可见时补查一次。 */
  dirty: boolean;
  readonly run: () => void;
  readonly refresh: DebouncedFn<[]>;
  readonly dispose: () => void;
}

const sources = new Map<string, Source>();
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...listeners]) l();
};
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

function createSource(root: string): Source {
  let disposed = false;
  let inFlight = false;
  let rerun = false;
  let staleRetries = 0;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const setIndex = (index: GitDecorationIndex | null): void => {
    if (source.index === index) return;
    source.index = index;
    emit();
  };
  const run = (): void => {
    if (disposed) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        const r = await coApi.git.status(root);
        if (disposed || !r.ok) return;
        if (r.data !== null && 'stale' in r.data) {
          if (staleRetries < GIT_STALE_RETRY_MAX && staleTimer === undefined) {
            staleRetries += 1;
            staleTimer = setTimeout(() => {
              staleTimer = undefined;
              run();
            }, GIT_STALE_RETRY_MS);
          }
          return;
        }
        staleRetries = 0;
        if (r.data === null) setIndex(null);
        else if (pathEquals(r.data.root, root)) setIndex(buildGitDecorationIndex(r.data.entries));
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
  const refresh = debounce(
    () => {
      if (disposed) return;
      if (![...source.consumers].some((c) => c.visible)) {
        source.dirty = true;
        return;
      }
      run();
    },
    GIT_REFRESH_DEBOUNCE_MS,
    { maxWait: GIT_REFRESH_MAX_WAIT_MS },
  );
  const unsubs: (() => void)[] = [];
  // 监听失败(如测试环境未注入对应 API)→ 只是少一个刷新来源,装饰仍按首查显示
  try {
    unsubs.push(
      coApi.fs.onDirChanged((path) => {
        if (isSameOrInsidePath(root, path)) refresh();
      }),
    );
  } catch {
    // 见上
  }
  unsubs.push(
    useEditorStore.subscribe((s, prev) => {
      if (savedSomething(s.tabs, prev.tabs)) refresh();
    }),
  );
  window.addEventListener('focus', refresh);
  const source: Source = {
    root,
    consumers: new Set(),
    index: null,
    dirty: false,
    run,
    refresh,
    dispose: () => {
      disposed = true;
      clearTimeout(staleTimer);
      refresh.cancel();
      for (const u of unsubs) u();
      window.removeEventListener('focus', refresh);
    },
  };
  return source;
}

/** 登记使用方;返回退出函数。首个使用方建立 source 并立即查询。 */
function acquire(root: string, consumer: Consumer): () => void {
  let source = sources.get(root);
  if (source === undefined) {
    source = createSource(root);
    sources.set(root, source);
    source.consumers.add(consumer);
    source.run();
  } else {
    source.consumers.add(consumer);
    if (consumer.visible) catchUp(source);
  }
  const s = source;
  return () => {
    s.consumers.delete(consumer);
    if (s.consumers.size > 0 || sources.get(root) !== s) return;
    s.dispose();
    sources.delete(root);
    if (s.index !== null) emit();
  };
}

/** 有使用方(重新)可见:无人可见期间记过脏 → 补查一次。 */
function catchUp(source: Source): void {
  if (!source.dirty) return;
  source.dirty = false;
  source.run();
}

/**
 * 窗口级共享的 git 状态(VSCode git 扩展的 status 刷新同思路;资源管理器、编辑器 tab、搜索结果共用):同一工作区根只有一个
 * 数据源 —— 首个使用方登记时取一次;根内的 fs 变化(复用资源管理器的 fs watch 广播,含仅内容变化)、编辑器保存、窗口获焦后
 * 防抖刷新。单飞:在途时再触发只记一次,完成后补跑。只要还有一个可见的使用方就照常刷新;全部不可见期间只记脏,任一方再次
 * 可见时补一次。最后一个使用方离开即停止监听、丢弃快照。enabled=false(该处装饰全关)→ 本使用方不登记、返回 null。
 * 非仓库 / 未装 git / 失败 → null(静默)。git 在 main 异步执行(超时 + 并发上限),这里只建索引。查询带上根,main 登记的根
 * 与之不符 → STALE,按 GIT_STALE_RETRY_MS 有限次重试(换根后装饰不必等获焦 / 文件变化)。
 * BDD: src/__tests__/explorer-git-decorations/、src/__tests__/editor-search-git-decorations/
 */
export function useGitStatus(root: string, enabled: boolean, visible: boolean): GitDecorationIndex | null {
  const consumerRef = useRef<Consumer | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!enabled) return;
    const consumer: Consumer = { visible: visibleRef.current };
    consumerRef.current = consumer;
    const release = acquire(root, consumer);
    return () => {
      consumerRef.current = null;
      release();
    };
  }, [root, enabled]);

  useEffect(() => {
    const consumer = consumerRef.current;
    if (consumer === null || consumer.visible === visible) return;
    consumer.visible = visible;
    const source = sources.get(root);
    if (visible && source?.consumers.has(consumer)) catchUp(source);
  }, [root, visible]);

  const index = useSyncExternalStore(subscribe, () => sources.get(root)?.index ?? null);
  return enabled ? index : null;
}
