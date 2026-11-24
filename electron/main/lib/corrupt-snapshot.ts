// 持久化文件「存在但无法解析」时的一次性留证:写 `${file}.corrupt`(flag:'wx' 只保第一份,不覆盖更早的
// 备份,也不在每次损坏读时重复写;0600)。best-effort,失败(含已存在)不影响主流程。
// 读端随后按空表降级的文件(explorer.json、插件 data.json、_enabled.json、_permissions.json)与损坏即中止写入的
// _plugin-path-scopes.json 共用 —— 前者的下一次 RMW 会覆盖原文件,不留证即不可恢复。
import fs from 'node:fs/promises';

export async function preserveCorruptSnapshot(file: string, raw: string): Promise<void> {
  try {
    await fs.writeFile(`${file}.corrupt`, raw, { flag: 'wx', mode: 0o600 });
  } catch {
    // 快照已存在(EEXIST)或写失败 → best-effort,忽略
  }
}
