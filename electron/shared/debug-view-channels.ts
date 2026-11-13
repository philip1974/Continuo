export const DEBUG_VIEW_CHANNELS = {
  EVENT: 'debug:event',
  SUBSCRIBE: 'debug:subscribe',
  GET_STACK: 'debug:getStack',
  GET_SCOPES: 'debug:getScopes',
  GET_VARIABLES: 'debug:getVariables',
} as const;

// debug 视图的数据形态:main(debug.service 产出)与 renderer(debug.store 消费)共用。preload 的
// getStack / getScopes / getVariables 返回的是 unknown,renderer 逐字段手工校验 —— 两侧各写一份接口时,
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
      readonly breakpoint: DebugBreakpoint;
    }
  | {
      readonly type: 'stopped';
      readonly sessionId: string;
      readonly stopSeq: number;
      readonly reason: string;
      readonly threadId?: number;
      readonly description?: string;
    }
  | {
      readonly type: 'continued';
      readonly sessionId: string;
      readonly runSeq: number;
    }
  | {
      readonly type: 'terminated';
      readonly sessionId: string;
      readonly reason: string;
    };

export interface DebugGetStackInput {
  readonly sessionId: string;
  readonly threadId?: number;
  readonly startFrame?: number;
  readonly levels?: number;
}

export interface DebugGetScopesInput {
  readonly sessionId: string;
  readonly frameId: number;
}

export interface DebugGetVariablesInput {
  readonly sessionId: string;
  readonly variablesReference: number;
  readonly start?: number;
  readonly count?: number;
  readonly maxDepth?: number;
  readonly maxStringBytes?: number;
}
