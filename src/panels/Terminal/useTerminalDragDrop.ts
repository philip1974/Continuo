import { useEffect, useRef, type RefObject } from 'react';
import type { DockviewGroupPanelApi } from 'dockview-react';
import { coApi } from '@/lib/co-api';
import { joinWithTrailingSpace, quotePaths } from '@continuo-terminal/shell-quote';
import { useT } from '@/i18n';
import { notify } from '@/notifications/notify';
import { getShellFamily } from '@/stores/terminal.store';

export interface UseTerminalDragDropInput {
  readonly sessionId: string;
  readonly focus: () => void;
  readonly api: Pick<DockviewGroupPanelApi, 'onDidLocationChange'>;
}

// 边界(E42,E41 终端 drop 兄弟):终端文件拖放此前把 dataTransfer.files 全量取 OS path 后对全部
// quotePaths()+join 一次性构造写入字符串,renderer 侧无文件数/输出长度上限。拖入海量文件/超长路径时
// 即使主 terminal.write 用 2MB schema 拒绝,renderer 已先做大量 getPathForFile IPC + 构造超大命令行
// 字符串 → UI 卡顿/内存峰值。读路径时累计:文件数超 MAX_TERMINAL_DROP_FILES 的项不再 IPC 取路径;
// 累计写入长度超 MAX_TERMINAL_DROP_CHARS(低于主 2MB 写入上限留 quote 余量)的项不再加入。超限项
// 计入 skipped 提示,绝不构造/写入超大字符串。
export const MAX_TERMINAL_DROP_FILES = 1000;
export const MAX_TERMINAL_DROP_CHARS = 1_000_000;

// 边界(E189/E224,E176 同族有界遍历):hasFiles 收口到共享 @/lib/window-drop(与 captureBoundedFiles /
// hasDirectoryInFirstItems 同处),Terminal 与 App.tsx 全局 drop 共用单一来源。此处 import 供本模块用 +
// re-export 保持既有 import 路径不变(Terminal 代码 + drag-drop.spec 仍从本模块 import hasFiles)。
import { captureBoundedFiles, hasFiles } from '@/lib/window-drop';
export { hasFiles };

// 边界(E189):DEV 调试日志的 types 也按上限有界读取(不全量 Array.from),防开发环境复现同类卡顿。
const DEBUG_TYPES_MAX = 32;
export function boundedTypes(dataTransfer: DataTransfer): string[] {
  const types = dataTransfer.types;
  const limit = Math.min(types.length, DEBUG_TYPES_MAX);
  const out = new Array<string>(limit);
  let count = 0;
  for (let i = 0; i < limit; i++) {
    out[count++] = types[i]!;
  }
  out.length = count;
  return out;
}

function pointInRect(
  x: number,
  y: number,
  rect: DOMRect | DOMRectReadOnly,
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.left &&
    x < rect.right &&
    y >= rect.top &&
    y < rect.bottom
  );
}

export function useTerminalDragDrop({
  sessionId,
  focus,
  api,
}: UseTerminalDragDropInput): {
  ref: RefObject<HTMLDivElement>;
} {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let boundDoc: Document | null = null;
    let disposed = false;
    let lastLocationType = 'grid';
    const listenerOptions = { capture: true } as const;

    const isTerminalFileDrag = (e: DragEvent): e is DragEvent & {
      dataTransfer: DataTransfer;
    } => {
      if (!hasFiles(e.dataTransfer)) return false;
      const dropZone = ref.current;
      if (dropZone === null) return false;
      return pointInRect(e.clientX, e.clientY, dropZone.getBoundingClientRect());
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isTerminalFileDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'copy';
    };

    const onDragOver = (e: DragEvent) => {
      if (!isTerminalFileDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'copy';
    };

    const onDrop = (e: DragEvent) => {
      if (!isTerminalFileDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const dataTransfer = e.dataTransfer;
      // 边界(E116,E114/E115 同族):DataTransfer.files 仅事件期有效须同步捕获,但不全量
      // Array.from 物化超大 FileList。同步截断到 MAX_TERMINAL_DROP_FILES + 1(多 1 个让下游
      // getPathForFile 循环的 cap 检测仍触发 partial_skip);未捕获的超限数记入 overLimitExtra,
      // seed 进 droppedForLimit 保证 partial_skip 计数准确。
      const fileList = dataTransfer.files;
      const totalFiles = fileList.length;
      const files = captureBoundedFiles(fileList, MAX_TERMINAL_DROP_FILES + 1);
      const overLimitExtra = totalFiles - files.length;

      if (import.meta.env.DEV) {
        console.debug('[terminal-drag-drop] capture drop', {
          sessionId,
          files: totalFiles,
          types: boundedTypes(dataTransfer), // 边界(E189):有界读取,不全量物化
        });
      }

      void (async () => {
        // a11y(A140 同族):fire-and-forget async 包 try/catch —— getPathForFile() 与
        // terminal.write() 的 IPC reject(抛错而非返回 {ok:false})此前未捕获 → unhandled
        // rejection,终端拖放文件失败时无 toast/live region 反馈。catch → 复用 write_failed。
        try {
          const paths = new Array<string>(
            Math.min(files.length, MAX_TERMINAL_DROP_FILES),
          );
          let pathCount = 0;
          let webDragCount = 0;
          let droppedForLimit = overLimitExtra; // 因数量/长度上限被丢弃(E42 + E116 同步截断的超限数)
          let approxLen = 0;

          for (const file of files) {
            // 边界(E42):文件数上限 —— 超出不再 IPC 取路径(省 getPathForFile 往返)。
            if (pathCount >= MAX_TERMINAL_DROP_FILES) {
              droppedForLimit += 1;
              continue;
            }
            const path = await coApi.window.getPathForFile(file);
            if (!path) {
              webDragCount += 1;
              continue;
            }
            // 边界(E42):累计写入长度上限 —— +3 估算 quote/空格余量,超出不再加入,防构造超大命令行。
            if (approxLen + path.length + 3 > MAX_TERMINAL_DROP_CHARS) {
              droppedForLimit += 1;
              continue;
            }
            paths[pathCount++] = path;
            approxLen += path.length + 3;
          }

          // race(R85):getPathForFile 循环可能跨多次 IPC 让权,期间用户关闭/切换 terminal panel
          // → effect cleanup(disposed=true)或以新 sessionId re-init。此处捕获的 sessionId/focus
          // 是旧实例的;不复查就 write 会向旧 session **意外注入输入**(若仍存活),或对已关闭实例
          // 弹误导性失败反馈。写前丢弃迟到任务。复用 effect 的 disposed 标志(per-effect)。
          if (disposed) return;

          paths.length = pathCount;
          const shellFamily = getShellFamily(sessionId);
          const { quoted, skipped } = quotePaths(paths, shellFamily);

          // 边界(E134):写入长度上限须按 **quote 后的真实长度** 复核 —— 循环里的 path.length + 3
          // 仅估算,POSIX/PowerShell 把每个 ' 展开成多字符(如 '\''),含大量单引号的路径 quote 后可
          // 显著膨胀,构造出远超 MAX_TERMINAL_DROP_CHARS 的命令行。逐项按真实 quoted 长度累计并截断。
          const cappedQuoted = new Array<string>(quoted.length);
          let cappedQuotedCount = 0;
          let realLen = 0;
          for (const q of quoted) {
            if (realLen + q.length + 1 > MAX_TERMINAL_DROP_CHARS) {
              droppedForLimit += 1;
              continue;
            }
            cappedQuoted[cappedQuotedCount++] = q;
            realLen += q.length + 1; // +1:joinWithTrailingSpace 的分隔/尾随空格
          }
          cappedQuoted.length = cappedQuotedCount;

          if (cappedQuoted.length === 0 && skipped.length === 0) {
            // 边界(E42):无可写路径时区分「全被大小/数量上限丢弃」与「全是 web drag 无 OS path」。
            // 前者(如单个 >1MB 路径)应提示 partial_skip,而非误导性的 no_os_path。
            if (droppedForLimit > 0) {
              notify.warn(
                t('panels.terminal.drag_drop.partial_skip', {
                  count: droppedForLimit + webDragCount,
                }),
              );
            } else {
              notify.warn(t('panels.terminal.drag_drop.no_os_path'));
            }
            return;
          }

          const r = await coApi.terminal.write(
            sessionId,
            joinWithTrailingSpace(cappedQuoted),
          );
          // race(R85):write IPC 期间若已 cleanup,不 focus 旧实例、不弹(对已关闭 panel)误导性反馈。
          if (disposed) return;
          if (!r.ok) {
            notify.warn(t('panels.terminal.drag_drop.write_failed'));
          } else {
            focus();
          }

          const skippedCount = skipped.length + webDragCount + droppedForLimit;
          if (skippedCount > 0) {
            notify.warn(
              t('panels.terminal.drag_drop.partial_skip', {
                count: skippedCount,
              }),
            );
          }
        } catch {
          notify.warn(t('panels.terminal.drag_drop.write_failed'));
        }
      })();
    };

    const unbind = (doc: Document) => {
      doc.removeEventListener('dragenter', onDragEnter, listenerOptions);
      doc.removeEventListener('dragover', onDragOver, listenerOptions);
      doc.removeEventListener('drop', onDrop, listenerOptions);
      if (boundDoc === doc) {
        boundDoc = null;
      }
    };

    const bind = () => {
      if (disposed || ref.current === null) return;
      const doc = ref.current.ownerDocument || document;
      if (doc === boundDoc) return;
      if (boundDoc !== null) unbind(boundDoc);
      doc.addEventListener('dragenter', onDragEnter, listenerOptions);
      doc.addEventListener('dragover', onDragOver, listenerOptions);
      doc.addEventListener('drop', onDrop, listenerOptions);
      boundDoc = doc;
      if (import.meta.env.DEV) {
        console.debug('[terminal-drag-drop] rebind', {
          sessionId,
          locationType: lastLocationType,
          ownerDocUrl: doc.URL,
        });
      }
    };

    bind();
    const sub = api.onDidLocationChange((event) => {
      lastLocationType = event.location.type;
      queueMicrotask(bind);
    });

    return () => {
      disposed = true;
      sub.dispose();
      if (boundDoc !== null) unbind(boundDoc);
      boundDoc = null;
    };
  }, [api, focus, sessionId, t]);

  return { ref: ref as RefObject<HTMLDivElement> };
}
