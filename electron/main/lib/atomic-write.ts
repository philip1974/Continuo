import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 原子写 JSON: temp + rename。
 * - temp 文件同目录(避免跨 FS rename 失败)
 * - unique suffix 防并发(本进程内 + 跨进程概率冲突)
 * - rename 后 temp 自动消失(rename 是原子)
 * - 失败时清理残留 temp
 */
export async function atomicWriteJson(
  filePath: string,
  payload: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempName = `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const tempPath = path.join(dir, tempName);
  const data = JSON.stringify(payload, null, 2);

  try {
    await fs.writeFile(tempPath, data, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}
