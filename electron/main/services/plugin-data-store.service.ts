import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import lockfile from 'proper-lockfile';
import { atomicWriteText } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { ERROR_CODES } from '../../shared/error-codes';
// 边界(E20,E13/E18/E19 同族):插件持久化 JSON 的序列化字节上限。save 原子写(atomicWriteText)、load
// 整文件 readFile + JSON.parse,无上限时畸形插件保存超大对象 / 磁盘残留超大 data.json 会让主进程
// JSON.stringify/parse 内存峰值 + 长时间阻塞。E43:常量移到 shared,renderer PluginDataStore 复用同值。
import { MAX_PLUGIN_DATA_BYTES } from '../../shared/plugin-data-limits';
import { assertJsonValue } from '../../shared/assert-json-value';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { isSafePluginId } from '../../shared/plugin-id';
import { PLUGIN_DATA_CHANNELS } from '../../shared/plugin-data-channels';
import { codedError } from '../../shared/error-message';
import { withInstalledPluginLock } from './plugins.service';
import { preserveCorruptSnapshot, quarantineCorruptFile } from '../lib/corrupt-snapshot';

const LOCK_OPTS: lockfile.LockOptions = {
  // Op12.5 spike not executed in this batch; using library defaults/recommendation.
  stale: 5_000,
  retries: { retries: 5, minTimeout: 50, maxTimeout: 500, factor: 2 },
};

export interface PluginDataStoreDeps {
  userDataPath: string;
  /** 落盘成功后回调(IPC 层据此向其它窗口广播缓存失效);失败不调用。 */
  onSaved?: (pluginId: string, event: IpcMainInvokeEvent) => void;
}

// plugin id 必须是单段安全标识符 —— 与 plugins.service / loader 的 id 正则一致。
// 拒绝路径分隔符 / .. / 空,防 dataFile() 的 join 越出 plugins 目录(路径穿越:
// save('../../foo',...) 可在 userData 外任意写/删/读文件)。
// 边界(E177):含长度上限(isSafePluginId)。绕过 wrapper 直调 pluginDataRaw.load / saveSerialized 时,超长合法 id
// 会进正则扫描 / path join / lockfile / 错误链路放大主进程 CPU / 内存 / 日志或触发 ENAMETOOLONG。
function assertPluginId(pluginId: unknown): asserts pluginId is string {
  if (typeof pluginId !== 'string' || !isSafePluginId(pluginId)) {
    // 边界(E177,E148 echo 族):不回显原始(可能超长)id,防错误消息经 IPC/日志放大;附稳定 code。
    throw codedError(ERROR_CODES.BAD_INPUT, 'invalid plugin id');
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

  ipcMain.handle(PLUGIN_DATA_CHANNELS.LOAD, async (_event, pluginId: string) => {
    const file = dataFile(pluginId);
    // 边界(E20;E161 stat-before-read TOCTOU 修正):此前 `fs.stat` 判大小 + `fs.readFile` 整文件两次
    // 独立路径解析,stat 与 read 之间文件可被替换/增长绕过 MAX_PLUGIN_DATA_BYTES。改用共享
    // readFileCappedFd(单 fd open→fstat 同 inode→有界读)。契约保持:open ENOENT→{};非 ENOENT
    // (EACCES 等)→throw;too-large→隔离 .corrupt 后降级 {}(不整块读入 + 不 parse)。
    let r: Awaited<ReturnType<typeof readFileCappedFd>>;
    try {
      // 安全:data.json 在插件安装目录内,目录内容来自插件仓库。noFollow:符号链接(ELOOP)/ 硬链接(EMLINK)
      // 一律当无数据 —— 否则恶意仓库提交 `data.json -> ../<别的插件>/data.json` 即可经 loadData() 读到其它
      // 插件的数据;也不走下面的 .corrupt 快照(会把链接目标的内容复制落盘)。
      r = await readFileCappedFd(file, MAX_PLUGIN_DATA_BYTES, { noFollow: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'EMLINK') return {};
      throw err; // 权限等真正的 IO 错误仍抛
    }
    if (r.tooLarge) {
      await quarantineCorruptFile(file);
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
        await preserveCorruptSnapshot(file, buf);
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      // 文件存在但 JSON 损坏(旧实现非原子写,崩溃/掉电会截断)。旧实现在这里直接
      // rethrow → IPC 永久 reject,该插件持久化数据"假死"丢失。改为:保留一次性
      // `.corrupt` 快照后降级返回 {},不阻塞插件继续运行(与 loadExplorer 同款)。
      await preserveCorruptSnapshot(file, buf);
      return {};
    }
  });

  // 保存:renderer 字节预检时已算好 value 的 JSON 文本,直接过 IPC(克隆字符串 ≪ 克隆对象图),此处不再
  // 遍历对象 + 二次 stringify。落盘文本 `{"value":<串>}` 与 JSON.stringify({ value }) 逐字节一致(data.json 契约
  // 是 plain object 包装),字节上限按落盘文本计;JSON.parse 证明串是**单个** JSON 值(拒非法 / 拼接注入,如
  // `1,"x":2` 会把包装撑出额外 key),解析结果再过 assertJsonValue 保留深度 / 宽度 / 字符串长度上限
  //(JSON.parse 产物本身不含 NaN / undefined / function)。
  ipcMain.handle(
    PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED,
    async (event, pluginId: string, serializedValue: unknown) => {
      assertPluginId(pluginId);
      if (typeof serializedValue !== 'string') {
        throw codedError(ERROR_CODES.BAD_INPUT, 'plugin data must be a serialized JSON string');
      }
      const serialized = `{"value":${serializedValue}}`;
      // 先廉价字节上限(utf8BytesExceed 早停)再 parse:超限串不进 JSON.parse 物化对象图。
      if (utf8BytesExceed(serialized, MAX_PLUGIN_DATA_BYTES)) {
        throw codedError(ERROR_CODES.PAYLOAD_TOO_LARGE, `plugin data too large (> ${MAX_PLUGIN_DATA_BYTES})`);
      }
      try {
        assertJsonValue(JSON.parse(serializedValue));
      } catch {
        throw codedError(ERROR_CODES.BAD_INPUT, 'plugin data not JSON-safe');
      }
      await writeSerialized(pluginId, serialized);
      deps.onSaved?.(pluginId, event);
    },
  );

  // 数据安全(卸载后复活目录):data.json 落在插件安装目录里。卸载时主进程先删目录,renderer 之后才跑 onunload,
  // 其中的 saveData(或更早发起、此刻才到的)若在这里 `mkdir -p` 就把目录建了回来 —— 只剩 data.json、没有 manifest:
  // 不被列出(UI 无卸载入口),同 id 再安装永远 EEXIST。与 path scope 持久化同法:进同 id mutation 锁(与安装 /
  // 卸载互斥),锁内确认插件目录仍在才写,不存在 → NOT_INSTALLED,**不创建目录**。
  // 内置插件(静态加载,不在 plugins 目录下)不使用 dataStore,不受影响。
  function writeSerialized(pluginId: string, serialized: string): Promise<void> {
    assertPluginId(pluginId);
    return withInstalledPluginLock(baseDir, pluginId, () => writeSerializedLocked(pluginId, serialized));
  }

  async function writeSerializedLocked(pluginId: string, serialized: string): Promise<void> {
    const file = dataFile(pluginId);
    // 创建 lock 目标文件:proper-lockfile 要求目标存在。必须用**排他创建**(wx)
    // 而非「access 判缺失 → writeFile 截断」:后者在加锁前 truncate,并发首次 save
    // 或 access 竞态(TOCTOU)会把另一次已落盘的 data.json 抹回 {},若随后加锁/写入
    // 失败则该数据静默丢失(数据安全复查 P1)。wx 仅当不存在时写空 {},已存在
    // 吞 EEXIST,绝不截断已有内容。真正的写入仍在持锁后由 atomicWriteText 完成。
    // 安全:data.json 是符号链接(来自插件仓库,见 LOAD)→ 先删链接。否则 proper-lockfile 按 realpath 把锁建到
    // 链接目标旁(悬空链接则 ENOENT,永远存不了);写入本身是 rename 替换链接,不会写穿。
    const existing = await fs.lstat(file).catch(() => null);
    if (existing?.isSymbolicLink()) await fs.unlink(file);
    try {
      await fs.writeFile(file, '{}', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(file, LOCK_OPTS);
      // 原子写(temp+fsync+rename):旧实现 fs.writeFile 先 truncate 再写,崩溃/
      // 掉电落在中途会把 data.json 截断成损坏 JSON(审计)。
      // 落盘的就是校验过的那份 `serialized`(校验对象 === 落盘对象);compact 文本,读取端只做 JSON.parse。
      await atomicWriteText(file, serialized);
    } finally {
      // release()(proper-lockfile 解锁)本身可能 reject —— 锁 stale(>5s)被其它
      // 进程接管、或 .lock 目录被外部清掉时抛 "Lock is not owned by you"。若
      // atomicWriteText 已成功而 release() reject,这个 finally 的 reject 会覆盖
      // 成功结果 → 一次本已落盘成功的写被 IPC 报成失败(未闭环:成功却报错,
      // 上层可能误触发重试或丢弃用户数据反馈)。解锁失败 best-effort 吞掉(锁会在
      // stale 超时后自动回收),不掩盖主结果。与上面 .corrupt 写同款 .catch 风格。
      if (release) await release().catch(() => {});
    }
  }

}
