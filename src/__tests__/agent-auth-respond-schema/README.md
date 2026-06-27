# agent-auth-respond-schema (E146)

agentAuth.respond IPC 应答 schema 的边界:requestId 须 1..256 字符、decision ∈ once/session/denied、strict。

防畸形/恶意 renderer 用超长 requestId 反复触发 IPC 解析 + pending.get 放大 main 内存/CPU
(与 plugin-fs scope-decision requestId ≤256 同型对齐)。
