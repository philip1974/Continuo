import type { AnyMcpTool, McpCallCtx } from './mcp-host.service';
import type * as terminalSessions from './terminal-sessions.service';
import type * as termService from './terminal.service';
import {
  makeCreateSessionTool,
  makeKillTool,
  makeListSessionsTool,
  makePressKeyTool,
  makeReadOutputTool,
  makeSendInputTool,
  makeSendTextTool,
  type CreateSessionPtyInput,
} from './mcp-tools-terminal';

export interface MakeTerminalMcpToolsDeps {
  readonly sessionStore: Pick<typeof terminalSessions, 'get' | 'getAll'>;
  readonly service: Pick<
    typeof termService,
    'has' | 'write' | 'interrupt' | 'kill' | 'forceKill' | 'readOutput'
  >;
  readonly getSessionOwner: (id: string) => number | null;
  readonly ensureAuthorized: () => Promise<'once' | 'session' | 'denied'>;
  readonly createSession: (
    input: CreateSessionPtyInput,
    ctx: McpCallCtx,
  ) => Promise<{ id: string }>;
}

export function makeTerminalMcpTools(
  deps: MakeTerminalMcpToolsDeps,
): readonly AnyMcpTool[] {
  return [
    makeListSessionsTool({
      getSessions: (ctx) =>
        deps.sessionStore.getAll({ ownerWindowId: ctx.ownerWindowId }),
    }),
    makeCreateSessionTool({
      ensureAuthorized: deps.ensureAuthorized,
      createSession: deps.createSession,
    }),
    makeSendInputTool({
      has: deps.service.has,
      write: deps.service.write,
      getSessionOwner: deps.getSessionOwner,
    }),
    makeSendTextTool({
      has: deps.service.has,
      write: deps.service.write,
      getSessionOwner: deps.getSessionOwner,
    }),
    makePressKeyTool({
      has: deps.service.has,
      write: deps.service.write,
      getSessionOwner: deps.getSessionOwner,
    }),
    makeReadOutputTool({
      read: deps.service.readOutput,
      getSessionOwner: deps.getSessionOwner,
    }),
    makeKillTool({
      has: deps.service.has,
      interrupt: deps.service.interrupt,
      kill: deps.service.kill,
      forceKill: deps.service.forceKill,
      getSessionOwner: deps.getSessionOwner,
    }),
  ];
}
