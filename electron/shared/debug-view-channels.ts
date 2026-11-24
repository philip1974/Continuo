import type { z } from 'zod';
import type {
  debugGetStackInputSchema,
  debugGetVariablesInputSchema,
} from './debug-view-schema';

export const DEBUG_VIEW_CHANNELS = {
  EVENT: 'debug:event',
  SUBSCRIBE: 'debug:subscribe',
  /** 当前停点的栈帧 + 首帧的作用域(面板不能切帧,一次取齐)。 */
  GET_STACK: 'debug:getStack',
  GET_VARIABLES: 'debug:getVariables',
} as const;

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
      /** 该 source 的完整断点集合(adapter 校正后的行号),renderer 用它整组替换 file 的记录。 */
      readonly file: string;
      readonly breakpoints: readonly DebugBreakpoint[];
    }
  | {
      readonly type: 'stopped';
      readonly sessionId: string;
      readonly stopSeq: number;
      readonly reason: string;
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
}

/** 面板 IPC 入参:由 main 的 zod schema 推出(单一来源,见 debug-view-schema.ts)。 */
export type DebugGetStackInput = z.infer<typeof debugGetStackInputSchema>;
export type DebugGetVariablesInput = z.infer<typeof debugGetVariablesInputSchema>;
