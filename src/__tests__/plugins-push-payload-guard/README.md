# plugins-push-payload-guard (E242)

main→renderer push 事件(`plugins:changed` / `plugins:protocol-url`)的 payload runtime 守卫。preload 的
onChanged / onProtocolUrl 此前直接解包 `payload.id` / `payload.url`,信任 main 形态:null payload 在
listener 抛、超长/非字符串 id 进 plugin-reload-gate pending Set 或触发 reload。

## 行为契约

- `isPluginsChangedPayload`:非空 string id 且 ≤ PLUGIN_ID_MAX_LEN(256)→ true,其余(null/非对象/非
  字符串/空/超长 id)→ false。
- `isProtocolUrlPayload`:非空 string url 且 ≤ PROTOCOL_URL_MAX_LEN(8192)→ true,其余 → false。
- preload onChanged / onProtocolUrl 复用守卫,畸形 payload warn+drop 不调 cb(与 fs:dir-changed /
  agent-auth push 守卫同款纵深防御)。
