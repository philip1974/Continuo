#!/usr/bin/env node
// Agent Terminal MCP — Phase 1 stub。
// 在 Continuo 内置 terminal 里跑(env 自动注入 CONTINUO_MCP_URL / TOKEN),
// 调 terminal.list_sessions tool,打印 JSON 响应。
//
// 用法:
//   node scripts/agent-cli-stub.mjs              # list_sessions
//   node scripts/agent-cli-stub.mjs <method>     # 任意 RPC method
//
// 不依赖 npm package,只用 node 内置 fetch(node 18+)。

const url = process.env.CONTINUO_MCP_URL;
const token = process.env.CONTINUO_MCP_TOKEN;

if (!url || !token) {
  console.error(
    '[stub] CONTINUO_MCP_URL / CONTINUO_MCP_TOKEN not set in env.\n' +
      '       Run this from inside a Continuo built-in terminal.',
  );
  process.exit(1);
}

// url 形如 http://127.0.0.1:<port>/sse;POST 走 /message
const messageUrl = url.replace(/\/sse$/, '/message');
const method = process.argv[2] ?? 'terminal.list_sessions';

const body = {
  jsonrpc: '2.0',
  id: `stub-${Date.now()}`,
  method,
  params: {},
};

try {
  const res = await fetch(messageUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`[stub] non-JSON response (${res.status}):`, text);
    process.exit(2);
  }
  console.log(JSON.stringify(parsed, null, 2));
  if (parsed.error) process.exit(3);
} catch (err) {
  console.error('[stub] request failed:', err.message ?? err);
  process.exit(4);
}
