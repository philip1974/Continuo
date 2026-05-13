# window-aware-agent-session

BDD scope for issue #29, following plan-v4 Approach: MCP terminal tools must resolve the caller BrowserWindow context before creating, listing, reading, writing, or killing terminal sessions.

Acceptance criteria:

1. Agent-created terminal sessions belong to the BrowserWindow that initiated the MCP call.
2. Default terminal titles are counted per window, so each window starts at `Terminal 1`.
3. Cross-window terminal access is isolated: sessions from other windows are hidden and operation attempts return not found semantics.

Popout subcase:

- Popout windows use their own BrowserWindow identity for caller context, while panels merely displayed through a popout keep the owner assigned at session creation time.
