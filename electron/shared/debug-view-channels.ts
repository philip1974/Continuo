import type { z } from 'zod';
import type {
  debugControlInputSchema,
  debugEvaluateInputSchema as debugViewEvaluateInputSchema,
  debugGetStackInputSchema,
  debugGetVariablesInputSchema,
  debugSetUserBreakpointInputSchema,
} from './debug-view-schema';

export const DEBUG_VIEW_CHANNELS = {
  EVENT: 'debug:event',
  SUBSCRIBE: 'debug:subscribe',
  /** 当前停点的栈帧 + 首帧的作用域(面板不能切帧,一次取齐)。 */
  GET_STACK: 'debug:getStack',
  GET_VARIABLES: 'debug:getVariables',
  /** 用户在调试工具栏 / 按键接管会话:继续 / 暂停 / 单步 / 停止(只作用于本窗口的会话,不经 agent 授权)。 */
  CONTROL: 'debug:control',
  /** 编辑器 gutter 切换断点:窗口级用户断点(存到下次 launch)+ 同步到本窗口的全部会话。 */
  SET_USER_BREAKPOINT: 'debug:setUserBreakpoint',
  /** 调试控制台求值(DAP evaluate context=repl)。 */
  EVALUATE: 'debug:evaluate',
} as const;

/** 调试工具栏 / 按键可发的动作(VSCode debugToolBar:continue / pause / stepOver / stepInto / stepOut / stop)。 */
export const DEBUG_CONTROL_ACTIONS = ['continue', 'pause', 'stepOver', 'stepIn', 'stepOut', 'stop'] as const;
export type DebugControlAction = (typeof DEBUG_CONTROL_ACTIONS)[number];

/**
 * 被调试程序的输出(DAP output 事件;telemetry 类别不收)。category 缺省按 DAP 规范为 console。
 * output 已去除 ANSI 转义、单条按 DEBUG_OUTPUT_ENTRY_BYTES_MAX 截断;seq 为会话内递增序号(read_output 的游标)。
 */
export interface DebugOutputEntry {
  readonly seq: number;
  readonly category: string;
  readonly output: string;
}

/** 单条输出的字节上限(超出截断)。 */
export const DEBUG_OUTPUT_ENTRY_BYTES_MAX = 16 * 1024;
/** 每个会话保留的输出条数上限(环形缓冲,丢最旧;VSCode REPL MAX_REPL_LENGTH 同为 10000)。 */
export const DEBUG_OUTPUT_ENTRIES_MAX = 10_000;
/** 每个会话保留的输出总字节上限(环形缓冲,丢最旧)。 */
export const DEBUG_OUTPUT_BYTES_MAX = 2 * 1024 * 1024;
/** subscribe 快照 / renderer 控制台保留的最近输出条数(面板只显示最近这些)。 */
export const DEBUG_VIEW_OUTPUT_ENTRIES_MAX = 1000;
/** 窗口级用户断点上限(同 subscribe 快照的断点上限)。 */
export const DEBUG_USER_BREAKPOINTS_MAX = 1000;

/** 用户在编辑器 gutter 设的断点(窗口级,存到下次 launch;file 为编辑器 tab 路径)。 */
export interface DebugUserBreakpoint {
  readonly file: string;
  readonly line: number;
}

// debug 视图的数据形态:main(debug.service 产出)与 renderer(debug.store 消费)共用。preload 的
// getStack / getVariables 返回的是 unknown,renderer 逐字段手工校验 —— 两侧各写一份接口时,
// main 改字段名编译器不会报错,renderer 只会把所有条目静默丢掉。
export interface DebugBreakpoint {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly verified: boolean;
  readonly message?: string;
}

export interface DebugStackFrame {
  readonly id: number;
  readonly name: string;
  readonly source_path?: string;
  readonly line: number;
  readonly column?: number;
}

export interface DebugScope {
  readonly name: string;
  readonly variables_reference: number;
  readonly expensive: boolean;
}

export interface DebugVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variables_reference?: number;
  readonly truncated?: boolean;
  readonly children?: readonly DebugVariable[];
}

export type DebugViewEvent =
  | {
      readonly type: 'breakpoints-changed';
      readonly sessionId: string;
      /** 面板显示的会话名(launch 的 name,无则程序文件名);renderer 缺省回退 sessionId。 */
      readonly label?: string;
      /** 该 source 的完整断点集合(adapter 校正后的行号),renderer 用它整组替换 file 的记录。 */
      readonly file: string;
      readonly breakpoints: readonly DebugBreakpoint[];
    }
  | {
      readonly type: 'stopped';
      readonly sessionId: string;
      /** 同 breakpoints-changed 的 label。 */
      readonly label?: string;
      readonly stopSeq: number;
      readonly reason: string;
    }
  | {
      /** 会话已建立(launch 完成):面板 / 工具栏据此显示运行中的会话(此前要等第一个断点或停点才出现)。 */
      readonly type: 'started';
      readonly sessionId: string;
      readonly label?: string;
    }
  | {
      /** 一批新输出(main 按短间隔合批推送,seq 递增)。 */
      readonly type: 'output';
      readonly sessionId: string;
      readonly entries: readonly DebugOutputEntry[];
    }
  | {
      readonly type: 'continued';
      readonly sessionId: string;
    }
  | {
      readonly type: 'terminated';
      readonly sessionId: string;
    };

/**
 * subscribe 快照里每个会话的断点总数上限(IPC payload 封顶;main 截断、renderer 校验时同样截断)。
 * 断点逐个由 agent / 用户设,正常远小于此。
 */
export const DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX = 1000;

/**
 * 按组截断总条数,**最新优先**:组按「最后一次变更」先后排列(最新在末尾),预算从最后一组往前分配,组内保留前段;
 * 整组被截掉的不返回,保留的组维持原顺序。main 的 subscribe 快照与 renderer debug.store(事件累计 / 快照解析 /
 * 快照与事件合并)共用 —— 两端规则不一致时重载前后看到的断点不同。
 */
export function capGroupsNewestFirst<T>(groups: readonly (readonly T[])[], max: number): T[][] {
  const kept: T[][] = [];
  let budget = max;
  for (let i = groups.length - 1; i >= 0 && budget > 0; i -= 1) {
    const items = groups[i]!.slice(0, budget);
    budget -= items.length;
    kept.push(items);
  }
  return kept.reverse();
}

/**
 * subscribe 返回的会话快照:renderer 重载(Cmd+R)后 store 为空、main 只推增量事件,据此恢复停点与断点,
 * 之后的事件照常增量。stop / breakpointsBySource 与 stopped / breakpoints-changed 事件同形。
 */
export interface DebugViewSessionSnapshot {
  readonly session_id: string;
  /** 面板显示的会话名(同事件的 label)。 */
  readonly label?: string;
  /** 当前停点(会话停住时才有)。 */
  readonly stop?: {
    readonly stopSeq: number;
    readonly reason: string;
  };
  /** 按 source 的完整断点集合(同 breakpoints-changed 事件的 file / breakpoints)。 */
  readonly breakpointsBySource: readonly {
    readonly file: string;
    readonly breakpoints: readonly DebugBreakpoint[];
  }[];
  /** 最近的输出(最多 DEBUG_VIEW_OUTPUT_ENTRIES_MAX 条):重载后控制台不清空。 */
  readonly output?: readonly DebugOutputEntry[];
}

/**
 * 用户断点变化(不属于某个会话):推给本窗口 renderer 的完整列表。与 DebugViewEvent 分开发(同一 EVENT 通道,
 * type 区分),renderer 整表替换。
 */
export interface DebugUserBreakpointsEvent {
  readonly type: 'user-breakpoints-changed';
  readonly breakpoints: readonly DebugUserBreakpoint[];
}

/** 面板 IPC 入参:由 main 的 zod schema 推出(单一来源,见 debug-view-schema.ts)。 */
export type DebugGetStackInput = z.infer<typeof debugGetStackInputSchema>;
export type DebugGetVariablesInput = z.infer<typeof debugGetVariablesInputSchema>;
export type DebugControlInput = z.infer<typeof debugControlInputSchema>;
export type DebugSetUserBreakpointInput = z.infer<typeof debugSetUserBreakpointInputSchema>;
export type DebugViewEvaluateInput = z.infer<typeof debugViewEvaluateInputSchema>;

/**
 * 能设断点的源文件扩展名(VSCode debug.allowBreakpointsEverywhere 默认 false:只有调试器声明了 breakpoints 的语言能在 gutter 设断点;
 * js-debug 声明 javascript / typescript / javascriptreact / typescriptreact 等 —— Continuo 只经 js-debug 调试 Node 程序,取这些语言的
 * 扩展名;js-debug 另声明的 html / wat / c / cpp / rust / zig / fsharp 属浏览器 / wasm 调试,这里不启动,故不收)。
 */
export const DEBUG_BREAKPOINT_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'] as const;

/** 该文件能否设断点(按扩展名,不区分大小写;编辑器 gutter 与 main 用户断点共用)。 */
export function canSetBreakpointsIn(file: string): boolean {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1).toLowerCase();
  return DEBUG_BREAKPOINT_FILE_EXTENSIONS.some((ext) => name.length > ext.length && name.endsWith(ext));
}
