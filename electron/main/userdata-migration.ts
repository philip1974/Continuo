// userData 一次性迁移(v0.2 改名 LayoutMotion → Continuo)。
//
// 触发:LM 启动时,检测 app.getPath('userData') 当前路径是否存在,
// 若不存在 + 旧路径存在 → mv 整个目录过去,保留 plugins / layout / explorer
// 等持久化数据。日志写主进程 console。
//
// 本逻辑只跑一次:迁移成功后下次启动新路径已存在,直接 short-circuit。
// 同 OS 同物理卷的 rename 是 O(1) 原子,失败时保留原路径不动。

import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';

/** 旧 -> 新 userData 路径迁移. */
export function migrateUserData(currentUserData: string): void {
  // 当前路径已存在(非首次启动 / 已迁移过) → 不动
  if (existsSync(currentUserData)) return;

  const parent = path.dirname(currentUserData);
  // 候选旧路径(dev = layout-motion;prod = LayoutMotion)
  const candidates = ['layout-motion', 'LayoutMotion'];

  for (const oldName of candidates) {
    const oldPath = path.join(parent, oldName);
    if (!existsSync(oldPath)) continue;
    try {
      renameSync(oldPath, currentUserData);
      console.log(
        `[userdata-migration] ${oldPath} → ${currentUserData}`,
      );
      return;
    } catch (err) {
      console.warn(
        `[userdata-migration] rename ${oldPath} → ${currentUserData} failed`,
        err,
      );
      // 不抛 — 让 LM 在新路径起步,旧数据保留可手动恢复
    }
  }
}
