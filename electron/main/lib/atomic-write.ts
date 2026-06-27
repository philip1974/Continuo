import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 原子写 JSON: temp + fsync + rename。
 * - temp 文件同目录(避免跨 FS rename 失败)
 * - unique suffix 防并发(本进程内 + 跨进程概率冲突)
 * - fsync temp:rename 前把数据页刷盘,防掉电时 rename 元数据先落盘而内容未落 →
 *   产生零字节/截断的 JSON(loadExplorer 解析失败回退默认值 = 全部历史丢失)
 * - rename 后 temp 自动消失(rename 是原子)
 * - 失败时清理残留 temp
 */
export async function atomicWriteJson(
  filePath: string,
  payload: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const data = JSON.stringify(payload, null, 2);

  // open 用 'wx'(排他创建),绝不用 'w' 盲目截断已存在的同名 temp:此 helper 现被
  // permissions/path-scopes/enabled/settings/explorer/plugin-data 复用,temp 名一旦撞到
  // 已有文件(残留/用户/测试可确定复现),'w' 会先把它截断、随后失败路径 unlink → 销毁
  // 非本次创建的文件。与兄弟 atomicWriteFile 的隐藏 tmp 'wx' 防御一致(同族传播)。撞名
  // 极罕见(pid+随机后缀),EEXIST 换新随机名重试;只清理本次 'wx' 确认创建的 temp。
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tempPath = '';
  for (let attempt = 0; ; attempt++) {
    tempPath = path.join(
      dir,
      `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      fh = await fs.open(tempPath, 'wx');
      break;
    } catch (err) {
      // EEXIST = 撞名(非本次创建,绝不截断/清理它)→ 换新随机名重试;其它错误直接抛。
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 4) {
        continue;
      }
      throw err;
    }
  }

  try {
    try {
      await fh.writeFile(data, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // 只清理本次 'wx' 成功创建的 temp(确属本次所有)。
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}
