// Editor 面板 / 编辑引擎 chunk 的共享加载器(perf E2 的配套)。
//
// EditorPlugin(面板 lazy)、EditorPanel(引擎 lazy)与 co-app(openFile({line}) 预加载)
// 共用同一组 promise:谁先触发谁下载,其余调用拿同一 promise,不重复发起 import。
// 失败的 promise 不缓存 —— 下次调用重新 import,配合 EditorPanel 的引擎错误边界「重试」
// 新建 lazy 实例(React.lazy 会永久缓存首个 rejection,只能换实例)。
//
// 本模块只静态依赖 react 的 lazy,不得静态 import CodeMirror / Milkdown(co-app 与
// EditorPlugin 在 main-app 启动路径上)。

import { lazy } from 'react';

export function cachedLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const current = load();
    pending = current;
    current.catch(() => {
      if (pending === current) pending = null;
    });
    return current;
  };
}

export const loadEditorPanelModule = cachedLoader(() => import('./EditorPanel'));
export const loadCodeEditorModule = cachedLoader(() => import('./CodeEditor'));
export const loadMilkdownEditorModule = cachedLoader(() => import('./MilkdownEditor'));

/** 新建 CodeEditor lazy 实例(重试时须新建,旧实例缓存了 rejection)。 */
export function createLazyCodeEditor() {
  return lazy(() => loadCodeEditorModule().then((m) => ({ default: m.CodeEditor })));
}

/** 新建 MilkdownEditor lazy 实例(重试时须新建,旧实例缓存了 rejection)。 */
export function createLazyMilkdownEditor() {
  return lazy(() =>
    loadMilkdownEditorModule().then((m) => ({ default: m.MilkdownEditor })),
  );
}

/**
 * 预加载 CodeEditor 挂载所需的全部 chunk(Editor 面板 + CodeEditor 引擎)。冷启动时二者
 * 是串行的两级 lazy;openFile({line}) 先并行拉齐,再开始有界的 view 挂载等待。
 */
export function preloadCodeEditorEngine(): Promise<void> {
  return Promise.all([loadEditorPanelModule(), loadCodeEditorModule()]).then(
    () => undefined,
  );
}
