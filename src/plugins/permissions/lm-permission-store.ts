// 用户 PermissionStore 单例(M-Plugin v4.7)。
// main.tsx 启动时实例化 IpcPermissionStore + 注入 PluginManager 同时,
// 把同一引用 set 进来给 UI(权限编辑器)直接读写。

import type { PermissionStore } from '../permissions';

let _store: PermissionStore | null = null;

export function setUserPermissionStore(s: PermissionStore): void {
  _store = s;
}

export function getUserPermissionStore(): PermissionStore | null {
  return _store;
}
