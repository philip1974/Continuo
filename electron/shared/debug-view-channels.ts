export const DEBUG_VIEW_CHANNELS = {
  EVENT: 'debug:event',
  SUBSCRIBE: 'debug:subscribe',
  GET_STACK: 'debug:getStack',
  GET_SCOPES: 'debug:getScopes',
  GET_VARIABLES: 'debug:getVariables',
} as const;

export type DebugViewEvent =
  | {
      readonly type: 'breakpoints-changed';
      readonly sessionId: string;
      readonly breakpoint: {
        readonly file: string;
        readonly line: number;
        readonly column?: number;
        readonly verified: boolean;
        readonly message?: string;
      };
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

export type DebugSubscribeInput = Record<string, never>;

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
