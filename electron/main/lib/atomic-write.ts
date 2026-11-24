import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ERROR_CODES } from '../../shared/error-codes';
import { codedError } from '../../shared/error-message';

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
  await atomicWriteText(filePath, JSON.stringify(payload, null, 2));
}

/**
 * 带总量上限的原子写 JSON:按落盘序列化(同 atomicWriteJson)量 UTF-8 字节,超过 maxBytes 抛 PAYLOAD_TOO_LARGE、不写
 * (原文件保持可读)。供「读端有字节上限、超限即抛且不降级」的文件(explorer.json、插件元数据表)用读端同一常量
 * 拒写 —— 否则写出读不回来的文件后不自愈。
 */
export async function atomicWriteJsonCapped(
  filePath: string,
  payload: unknown,
  maxBytes: number,
): Promise<void> {
  const text = JSON.stringify(payload, null, 2);
  // UTF-16 长度 ×3 ≥ UTF-8 字节:未超时免一次全量编码。
  if (text.length * 3 > maxBytes && Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw codedError(
      ERROR_CODES.PAYLOAD_TOO_LARGE,
      `${path.basename(filePath)} would exceed ${maxBytes} bytes; write rejected`,
    );
  }
  await atomicWriteText(filePath, text);
}

export interface AtomicWriteOptions {
  /** 目标文件的最终权限(创建后再 chmod,不受 umask 削减);缺省 0600(以 0600 创建,受 umask)。 */
  readonly mode?: number;
}

/**
 * 原子写已序列化内容(文本按 UTF-8;二进制逐字节;语义同 atomicWriteJson,见上)。供调用方已持有序列化结果时
 * 复用,避免为落盘再 stringify 一次(perf:大 payload 的第二次全量遍历 + 第二份大字符串)。
 */
export async function atomicWriteText(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);

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
      // 安全(多用户 Linux):本 helper 只写 userData 内部文件(explorer/settings/插件授权与数据/stdio
      // 发现文件),以 0600 创建 temp;rename 后目标即 0600(覆盖既有 0644 也随之收紧)。默认 0666&umask
      // 会让同机其他用户读到工作区路径、插件授权与插件数据。Windows 上 mode 仅影响只读位,无副作用。
      fh = await fs.open(tempPath, 'wx', options.mode ?? 0o600);
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
      // 显式 mode(如可执行脚本 0700)须原样落地:umask 可能去掉执行位。
      if (options.mode !== undefined) await fh.chmod(options.mode);
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
