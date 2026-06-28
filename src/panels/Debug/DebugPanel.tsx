import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, ScrollArea, Tabs, type TabItem } from '@/design';
import {
  startDebugStoreSync,
  useDebugStore,
  type DebugScope,
  type DebugSessionShadow,
} from '@/stores/debug.store';
import { useLocale, useT } from '@/i18n';

const EMPTY_VARIABLES: readonly [] = [];

export function DebugPanel() {
  const t = useT();
  const locale = useLocale();
  const [activeTab, setActiveTab] = useState('stack');
  const activeSessionId = useDebugStore((state) => state.activeSessionId);
  const session = useDebugStore((state) =>
    state.activeSessionId !== null
      ? state.sessions.get(state.activeSessionId)
      : undefined,
  );
  const debugTabs = useMemo<readonly TabItem[]>(
    () => {
      void locale;
      return [
        { id: 'stack', label: t('panels.debug.tab.stack') },
        { id: 'variables', label: t('panels.debug.tab.variables') },
        { id: 'breakpoints', label: t('panels.debug.tab.breakpoints') },
      ];
    },
    [locale, t],
  );

  useEffect(() => {
    startDebugStoreSync();
  }, []);

  if (!activeSessionId || !session) {
    return (
      <div className="flex h-full w-full bg-canvas p-3 text-fg">
        <Card className="flex flex-1 items-center justify-center text-xs text-fg-muted">
          {t('panels.debug.empty_session')}
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full gap-3 bg-canvas p-3 text-fg">
      <aside className="w-36 shrink-0">
        <Tabs
          items={debugTabs}
          activeId={activeTab}
          onSelect={setActiveTab}
          ariaLabel={t('panels.debug.views_aria')}
        />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <DebugSessionHeader session={session} />
        <ScrollArea>
          {activeTab === 'stack' && <StackSection session={session} />}
          {activeTab === 'variables' && <VariablesSection session={session} />}
          {activeTab === 'breakpoints' && <BreakpointsSection session={session} />}
        </ScrollArea>
      </section>
    </div>
  );
}

function DebugSessionHeader({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  const location =
    session.stopped?.file !== undefined && session.stopped.line !== undefined
      ? `${session.stopped.file}:${session.stopped.line}`
      : t('panels.debug.paused');
  return (
    <Card className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-fg">{session.id}</div>
        <div className="truncate text-xs text-fg-muted">{location}</div>
      </div>
      <Badge variant={session.stopped ? 'warning-soft' : 'neutral'}>
        {session.stopped?.reason ?? t('panels.debug.running')}
      </Badge>
    </Card>
  );
}

function StackSection({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  if (session.frames.length === 0) {
    return <EmptyCard label={t('panels.debug.empty_stack')} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {session.frames.map((frame) => (
        <Card key={frame.id}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">{frame.name}</div>
              <div className="truncate text-xs text-fg-muted">
                {frame.source_path ?? t('panels.debug.unknown')}:{frame.line}
              </div>
            </div>
            <Badge variant="info">#{frame.id}</Badge>
          </div>
        </Card>
      ))}
    </div>
  );
}

function VariablesSection({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  if (session.scopes.length === 0) {
    return <EmptyCard label={t('panels.debug.empty_variables')} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {session.scopes.map((scope) => (
        <ScopeCard key={scope.variables_reference} session={session} scope={scope} />
      ))}
    </div>
  );
}

function ScopeCard({
  session,
  scope,
}: {
  readonly session: DebugSessionShadow;
  readonly scope: DebugScope;
}) {
  const t = useT();
  const loadVariables = useDebugStore((state) => state.loadVariables);
  const [loading, setLoading] = useState(false);
  const variables = useDebugStore(
    (state) =>
      state.sessions
        .get(session.id)
        ?.variableRefs.get(scope.variables_reference) ?? EMPTY_VARIABLES,
  );

  const load = async () => {
    setLoading(true);
    try {
      await loadVariables(session.id, scope.variables_reference);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg">{scope.name}</div>
          <div className="text-xs text-fg-muted">
            {t('panels.debug.scope_ref', { ref: scope.variables_reference })}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          {loading
            ? t('common.loading')
            : t('panels.debug.load_scope', { scope: scope.name })}
        </Button>
      </div>
      {variables.length > 0 && (
        <div className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
          {variables.map((variable) => (
            <div
              key={variable.name}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs"
            >
              <span className="truncate text-fg">{variable.name}</span>
              <span className="truncate text-fg-muted">{variable.value}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function BreakpointsSection({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  const rows = useMemo(() => session.breakpoints, [session.breakpoints]);
  if (rows.length === 0) {
    return <EmptyCard label={t('panels.debug.empty_breakpoints')} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map((breakpoint) => (
        <Card key={`${breakpoint.file}:${breakpoint.line}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">
                {breakpoint.file}:{breakpoint.line}
              </div>
              {breakpoint.message && (
                <div className="truncate text-xs text-fg-muted">
                  {breakpoint.message}
                </div>
              )}
            </div>
            <Badge variant={breakpoint.verified ? 'success-soft' : 'warning-soft'}>
              {breakpoint.verified
                ? t('panels.debug.breakpoint.verified')
                : t('panels.debug.breakpoint.pending')}
            </Badge>
          </div>
        </Card>
      ))}
    </div>
  );
}

function EmptyCard({ label }: { readonly label: string }) {
  return (
    <Card className="flex min-h-24 items-center justify-center text-xs text-fg-muted">
      {label}
    </Card>
  );
}
