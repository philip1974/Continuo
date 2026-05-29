import { coApi } from '@/lib/co-api';
import type { PathScope } from '../types';
import { usePermissionPromptStore, type FsScopePromptScope } from './promptStore';

interface ScopeRequestPayload {
  readonly requestId: string;
  readonly pluginId: string;
  readonly scopes: readonly PathScope[];
}

function homeForDisplay(): string | null {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  return maybeProcess?.env?.['HOME'] ?? maybeProcess?.env?.['USERPROFILE'] ?? null;
}

export function expandScopePathForDisplay(path: string): string {
  if (path === '~') return homeForDisplay() ?? path;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    const home = homeForDisplay();
    return home ? `${home}${path.slice(1)}` : path;
  }
  return path;
}

export function startPluginFsScopeRequestBridge(): () => void {
  return coApi.pluginFsRaw.onScopeRequest((payload: ScopeRequestPayload) => {
    const scopes: FsScopePromptScope[] = payload.scopes.map((scope) => ({
      ...scope,
      displayPath: expandScopePathForDisplay(scope.path),
    }));
    void usePermissionPromptStore
      .getState()
      .requestFsScope({
        requestId: payload.requestId,
        pluginId: payload.pluginId,
        scopes,
      })
      .then((decision) =>
        coApi.pluginFsRaw._scopeDecision(payload.requestId, decision),
      );
  });
}
