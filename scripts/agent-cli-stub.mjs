#!/usr/bin/env node
// Agent Terminal MCP — stub(P4+ 升级:走 MCP 标准协议 tools/call)。
// 在 Continuo 内置 terminal 里跑(env 自动注入 CONTINUO_MCP_URL / TOKEN),
// 模拟最小 MCP client:initialize → tools/call → 打印响应。
//
// 用法:
//   node scripts/agent-cli-stub.mjs                          # tools/list 列工具
//   node scripts/agent-cli-stub.mjs <tool>                   # tools/call,空 arguments
//   node scripts/agent-cli-stub.mjs <tool> '<json-args>'     # tools/call 带参
//
// 特殊命令:
//   node scripts/agent-cli-stub.mjs --initialize             # 仅做 initialize 握手
//   node scripts/agent-cli-stub.mjs --raw <method> '<json>'  # 直接发 raw RPC method(调试用)
//
// 例子:
//   agent-cli-stub.mjs terminal.list_sessions
//   agent-cli-stub.mjs terminal.create_session '{"autorun":"echo hi","name":"test"}'
//   agent-cli-stub.mjs terminal.read_output    '{"session_id":"term-xxx","max_lines":50}'
//   agent-cli-stub.mjs terminal.send_input     '{"session_id":"term-xxx","data":"ls\n"}'
//   agent-cli-stub.mjs terminal.kill           '{"session_id":"term-xxx","signal":"SIGINT"}'
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

let nextId = 1;
const rpcId = () => `stub-${Date.now()}-${nextId++}`;

async function send(body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (text.length === 0) return null; // 202 Accepted (notification)
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`[stub] non-JSON response (${res.status}):`, text);
    process.exit(2);
  }
  return parsed;
}

const args = process.argv.slice(2);

// --raw <method> '<json>' 直接发 raw RPC(调试用,不走 tools/call 包装)
if (args[0] === '--raw') {
  const method = args[1] ?? '';
  if (!method) {
    console.error('[stub] --raw requires <method>');
    process.exit(1);
  }
  let params = {};
  if (args[2]) {
    try {
      params = JSON.parse(args[2]);
    } catch (err) {
      console.error('[stub] invalid params JSON:', err.message ?? err);
      process.exit(1);
    }
  }
  const r = await send({ jsonrpc: '2.0', id: rpcId(), method, params });
  console.log(JSON.stringify(r, null, 2));
  if (r?.error) process.exit(3);
  process.exit(0);
}

// --initialize 仅握手
if (args[0] === '--initialize') {
  const r = await send({
    jsonrpc: '2.0',
    id: rpcId(),
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'continuo-stub', version: '0.1.0' },
      capabilities: {},
    },
  });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r?.error ? 3 : 0);
}

// 标准流程:initialize → (tools/list 或 tools/call)
const tool = args[0];
const argsRaw = args[1];

let toolArgs = {};
if (argsRaw) {
  try {
    toolArgs = JSON.parse(argsRaw);
    if (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
      throw new Error('arguments must be a JSON object');
    }
  } catch (err) {
    console.error('[stub] invalid arguments JSON:', err.message ?? err);
    process.exit(1);
  }
}

// 1. initialize(必须先做,Claude Code 也是这个顺序)
const initR = await send({
  jsonrpc: '2.0',
  id: rpcId(),
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'continuo-stub', version: '0.1.0' },
    capabilities: {},
  },
});
if (initR?.error) {
  console.error('[stub] initialize failed:');
  console.error(JSON.stringify(initR, null, 2));
  process.exit(3);
}

// 2. notifications/initialized(无 id 通知,server 应 202)
await send({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
  params: {},
});

// 3. 没指定 tool → tools/list
if (!tool) {
  const r = await send({
    jsonrpc: '2.0',
    id: rpcId(),
    method: 'tools/list',
    params: {},
  });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r?.error ? 3 : 0);
}

// 4. 指定 tool → tools/call
const r = await send({
  jsonrpc: '2.0',
  id: rpcId(),
  method: 'tools/call',
  params: { name: tool, arguments: toolArgs },
});
console.log(JSON.stringify(r, null, 2));
if (r?.error) process.exit(3);
