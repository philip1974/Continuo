import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import lockfile from 'proper-lockfile';
import { atomicWriteJson } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { ERROR_CODES } from '../../shared/error-codes';
// 边界(E20,E13/E18/E19 同族):插件持久化 JSON 的序列化字节上限。save 直接 atomicWriteJson、load
// 整文件 readFile + JSON.parse,无上限时畸形插件保存超大对象 / 磁盘残留超大 data.json 会让主进程
// JSON.stringify/parse 内存峰值 + 长时间阻塞。E43:常量移到 shared,renderer PluginDataStore 复用同值。
import { MAX_PLUGIN_DATA_BYTES } from '../../shared/plugin-data-limits';
import { assertJsonValue } from '../../shared/assert-json-value';
import { utf8ByteLength } from '../../shared/utf8-byte-length';
import { jsonByteLowerBoundExceeds } from '../../shared/json-byte-budget';

const LOCK_OPTS: lockfile.LockOptions = {
  // Op12.5 spike not executed in this batch; using library defaults/recommendation.
  stale: 5_000,
  retries: { retries: 5, minTimeout: 50, maxTimeout: 500, factor: 2 },
};

export interface PluginDataStoreDeps {
  userDataPath: string;
}

// plugin id 必须是单段安全标识符 —— 与 plugins.service / loader 的 id 正则一致。
// 拒绝路径分隔符 / .. / 空,防 dataFile() 的 join 越出 plugins 目录(路径穿越:
// save('../../foo',...) 可在 userData 外任意写/删/读文件)。
const PLUGIN_ID_RE = /^[a-z0-9._-]+$/;
// 边界(E177):pluginId 长度上限(对齐 plugins.service / plugin-mcp-schemas / plugins.ipc 的
// PLUGIN_ID_MAX=256)。绕过 wrapper 直调 pluginDataRaw.load/save/clear 时,超长合法 id 会进正则扫描/
// path join/lockfile/错误链路放大主进程 CPU/内存/日志或触发 ENAMETOOLONG。
const PLUGIN_ID_MAX = 256;

function assertPluginId(pluginId: unknown): asserts pluginId is string {
  if (
    typeof pluginId !== 'string' ||
    pluginId.length === 0 ||
    pluginId.length > PLUGIN_ID_MAX ||
    pluginId === '.' ||
    pluginId === '..' ||
    !PLUGIN_ID_RE.test(pluginId)
  ) {
    // 边界(E177,E148 echo 族):不回显原始(可能超长)id,防错误消息经 IPC/日志放大;附稳定 code。
    throw Object.assign(new Error('invalid plugin id'), {
      code: ERROR_CODES.BAD_INPUT,
    });
  }
}

export function registerPluginDataStoreHandlers(
  ipcMain: IpcMain,
  deps: PluginDataStoreDeps,
): void {
  const baseDir = join(deps.userDataPath, 'plugins');
  const dataFile = (pluginId: string): string => {
    assertPluginId(pluginId);
    return join(baseDir, pluginId, 'data.json');
  };

  async function ensureDir(pluginId: string): Promise<string> {
    assertPluginId(pluginId);
    const dir = join(baseDir, pluginId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  ipcMain.handle('plugin-data:load', async (_event, pluginId: string) => {
    const file = dataFile(pluginId);
    // 边界(E20;E161 stat-before-read TOCTOU 修正):此前 `fs.stat` 判大小 + `fs.readFile` 整文件两次
    // 独立路径解析,stat 与 read 之间文件可被替换/增长绕过 MAX_PLUGIN_DATA_BYTES。改用共享
    // readFileCappedFd(单 fd open→fstat 同 inode→有界读)。契约保持:open ENOENT→{};非 ENOENT
    // (EACCES 等)→throw;too-large→隔离 .corrupt 后降级 {}(不整块读入 + 不 parse)。
    let r: Awaited<ReturnType<typeof readFileCappedFd>>;
    try {
      r = await readFileCappedFd(file, MAX_PLUGIN_DATA_BYTES);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err; // 权限等真正的 IO 错误仍抛
    }
    if (r.tooLarge) {
      await fs.rename(file, `${file}.corrupt`).catch(() => {});
      return {};
    }
    const buf = r.text as string; // tooLarge=false 时 text 必为 string
    try {
      const parsed = JSON.parse(buf) as unknown;
      // 边界(E147):data.json 契约是 plain object({value:...} 包装)。外部残留/绕过 renderer 的
      // raw IPC 可写入合法 JSON 但畸形形态(null/字符串/数组)→ renderer load 的
      // hasOwnProperty.call(data,'value') 对 null 抛 TypeError / 对非对象返 false(把已存数据当
      // 不存在 = 假丢失)。非 plain object 视为损坏:隔离 .corrupt 后降级 {}(同 JSON 损坏路径)。
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        await fs.writeFile(`${file}.corrupt`, buf, { flag: 'wx' }).catch(() => {});
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      // 文件存在但 JSON 损坏(旧实现非原子写,崩溃/掉电会截断)。旧实现在这里直接
      // rethrow → IPC 永久 reject,该插件持久化数据"假死"丢失。改为:保留一次性
      // `.corrupt` 快照后降级返回 {},不阻塞插件继续运行(与 loadExplorer 同款)。
      await fs.writeFile(`${file}.corrupt`, buf, { flag: 'wx' }).catch(() => {});
      return {};
    }
  });

  ipcMain.handle(
    'plugin-data:save',
    async (_event, pluginId: string, data: Record<string, unknown>) => {
      // 边界(E147):data.json 契约是 plain object({value:...} 包装)。绕过 renderer 的 raw IPC 可传
      // 数组/原语(string/number/boolean)→ 写出畸形 data.json,致 load 端 hasOwnProperty 抛/假丢失。
      // null/undefined 归一为 {}(安全空),其余非 plain object 拒写。
      const payload = data ?? {};
      if (typeof payload !== 'object' || Array.isArray(payload)) {
        throw Object.assign(new Error('plugin data must be a plain object'), {
          code: ERROR_CODES.BAD_INPUT,
        });
      }
      // 边界(E306,E305 reorder 同族 / 校验顺序 fail-fast):先廉价字节下界 fail-fast(早停于上限)再
      // assertJsonValue 全量遍历 —— 超 16MiB 但 shape 合法的 payload 不被 assertJsonValue 完整遍历后才拒。
      // jsonByteLowerBoundExceeds 对任意输入安全(E288)可先跑。(仅「既非 JSON-safe 又超限」的病态输入
      // 错误码从 BAD_INPUT 变 PAYLOAD_TOO_LARGE —— 两者皆拒写,无现实差异。)
      if (jsonByteLowerBoundExceeds(payload, MAX_PLUGIN_DATA_BYTES)) {
        throw Object.assign(
          new Error(`plugin data too large (> ${MAX_PLUGIN_DATA_BYTES})`),
          { code: ERROR_CODES.PAYLOAD_TOO_LARGE },
        );
      }
      // 边界(E103,main 兜底):JSON.stringify 静默改写 NaN/Infinity→null、丢 undefined/function
      //(不抛)→ 静默持久化损坏。assertJsonValue 递归拒非 JSON 安全值(renderer 已预检,此为兜底,
      // 挡绕过 renderer 的入口)。
      try {
        assertJsonValue(payload);
      } catch {
        throw Object.assign(new Error('plugin data not JSON-safe'), {
          code: ERROR_CODES.BAD_INPUT,
        });
      }
      // 边界(E20):序列化前校验 + 字节上限。畸形插件保存超大对象会让 JSON.stringify 内存峰值 +
      // 写出超大 data.json(下次 load 再放大)。不可序列化(循环引用)或超限 → 明确拒绝,不写。
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        throw Object.assign(new Error('plugin data not serializable'), {
          code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        });
      }
      // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit)。
      const dataBytes = utf8ByteLength(serialized);
      if (dataBytes > MAX_PLUGIN_DATA_BYTES) {
        throw Object.assign(
          new Error(
            `plugin data too large (${dataBytes} > ${MAX_PLUGIN_DATA_BYTES})`,
          ),
          { code: ERROR_CODES.PAYLOAD_TOO_LARGE },
        );
      }
      await ensureDir(pluginId);
      const file = dataFile(pluginId);
      // 创建 lock 目标文件:proper-lockfile 要求目标存在。必须用**排他创建**(wx)
      // 而非「access 判缺失 → writeFile 截断」:后者在加锁前 truncate,并发首次 save
      // 或 access 竞态(TOCTOU)会把另一次已落盘的 data.json 抹回 {},若随后加锁/写入
      // 失败则该数据静默丢失(codex 数据安全复查 P1)。wx 仅当不存在时写空 {},已存在
      // 吞 EEXIST,绝不截断已有内容。真正的写入仍在持锁后由 atomicWriteJson 完成。
      try {
        await fs.writeFile(file, '{}', { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }

      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockfile.lock(file, LOCK_OPTS);
        // 原子写(temp+fsync+rename):旧实现 fs.writeFile 先 truncate 再写,崩溃/
        // 掉电落在中途会把 data.json 截断成损坏 JSON(审计)。
        // 边界(E237):写**归一后的 payload**(data ?? {}),不是原始 data。校验/序列化/字节上限全跑
        // payload,但此前落盘写原始 data —— 绕过 renderer 的 raw IPC 传 null/undefined 时 payload={} 过
        // 校验,却把 null/undefined 写进 data.json,破坏 plain object 契约 → 下次 load 当损坏隔离降级 →
        // 插件数据静默丢失。写 payload 使校验对象与落盘对象一致。
        await atomicWriteJson(file, payload);
      } finally {
        // release()(proper-lockfile 解锁)本身可能 reject —— 锁 stale(>5s)被其它
        // 进程接管、或 .lock 目录被外部清掉时抛 "Lock is not owned by you"。若
        // atomicWriteJson 已成功而 release() reject,这个 finally 的 reject 会覆盖
        // 成功结果 → 一次本已落盘成功的写被 IPC 报成失败(未闭环:成功却报错,
        // 上层可能误触发重试或丢弃用户数据反馈)。解锁失败 best-effort 吞掉(锁会在
        // stale 超时后自动回收),不掩盖主结果。与上面 .corrupt 写同款 .catch 风格。
        if (release) await release().catch(() => {});
      }
    },
  );

  ipcMain.handle('plugin-data:clear', async (_event, pluginId: string) => {
    // force:true 已容忍「文件不存在」(ENOENT,已清空视为成功);但**不**吞 EACCES/EBUSY/
    // IO 等真删除失败 —— 旧实现 try/catch 吞掉所有 rm 错误,删除失败仍报成功,调用方以为
    // 数据已清除、重启/下次读取却恢复旧数据(codex 数据安全复查)。真错误传播给调用方。
    await fs.rm(dataFile(pluginId), { force: true });
  });
}
