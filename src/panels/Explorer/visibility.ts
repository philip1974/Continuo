import { createContext } from 'react';

/**
 * Explorer 是否对用户可见。ExplorerSidebar 关闭时保持文件树挂载但隐藏(保留 headless-tree 实例、
 * dataLoader 缓存、watcher 与滚动位置),此 context 为 false;FolderTree 据此把隐藏期间的
 * dir-changed 刷新延后到再次显示时批量执行。默认 true(不在侧栏内渲染时行为不变)。
 */
export const ExplorerVisibleContext = createContext(true);
