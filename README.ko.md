# Continuo — 터미널 네이티브 에이전트를 위한 오픈소스 GUI 기반

[English](README.md) · [简体中文](README.zh-CN.md) · **한국어**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/philip1974/Continuo?style=social)](https://github.com/philip1974/Continuo)

Claude Code, Codex CLI, Aider 또는 직접 만든 에이전트를 도킹 가능한 멀티 터미널 GUI 안에서 실행하세요. 에이전트는 대상 창에서 당신이 허용한 뒤에만 동작하며, 플러그인은 사용할 권한을 선언합니다 (플러그인은 샌드박스에서 실행되지 않으므로 신뢰하는 플러그인만 설치하세요). **당신의 에이전트를 그대로 가져오세요.**

> **왜 만들었나:** 코딩 에이전트 하나만 쓰면, 끝나지 않았는데도 "완료"라고 말합니다. Continuo에서는 여러 터미널 에이전트를 한 창에서 함께 돌릴 수 있습니다 — 하나는 작업하고 다른 하나는 검토하게 해서, 마지막 "완료"를 그냥 믿는 대신 각자가 실제로 무엇을 했는지 볼 수 있습니다.

## 다운로드

미리 빌드된 설치 파일은 [Releases 페이지](https://github.com/philip1974/Continuo/releases)에 게시됩니다. 소스에서 직접 빌드할 수도 있습니다 (아래 **빠른 시작** 참고).

얼리 액세스 빌드는 **macOS (Apple Silicon) 전용이며 서명되지 않았습니다**: `.dmg`를 마운트하고 Continuo를 **응용 프로그램** 폴더로 드래그한 뒤 **앱을 우클릭 → 열기 → 열기**를 선택해 Gatekeeper를 통과하세요 (macOS 14 이하). macOS 15 이상에서는 한 번 열기를 시도한 뒤 시스템 설정 → 개인정보 보호 및 보안에서 **그래도 열기**를 누르세요. 앱이 "손상되었다"는 메시지가 나오면 다운로드 격리 플래그를 제거하세요: `xattr -dr com.apple.quarantine /Applications/Continuo.app`. 코드 서명 / 공증과 Windows / Linux 빌드는 이후에 제공됩니다.

## 첫 실행 피드백

1. 소스에서 빌드하거나(아래 **빠른 시작**), Releases 페이지에서 빌드를 내려받으세요 (서명되지 않음 — 위의 Gatekeeper 안내 참고).
2. MCP stdio 브리지를 통해 평소 쓰는 터미널 에이전트를 연결하세요.
3. 어떤 일이 있었는지 알려 주세요: OS, 에이전트, 그리고 설정이나 MCP가 실패한 정확한 단계.

유용한 피드백:

- 앱이 열렸나요?
- 어떤 에이전트를 시도했나요: Claude Code, Codex CLI, Aider, 아니면 직접 만든 것?
- 설치나 MCP 연동이 어디서 실패했나요?
- 실제 작업을 위해 두 번째로 다시 사용하시겠어요?

피드백 / 이슈:
<https://github.com/philip1974/Continuo/issues/new?template=first-run-feedback.md>

## 무엇이 "아닌가"

- ❌ 또 하나의 AI Markdown 에디터가 아닙니다
- ❌ Cursor / VSCode 경쟁 제품이 아닙니다
- ❌ 클라우드 호스팅이 아니며, 동기화 서비스가 없습니다
- ❌ 특정 에이전트 브랜드에 묶여 있지 않습니다

## 빠른 시작

**Node 24** 와 **pnpm 9 이상**이 필요합니다.

> **플랫폼 지원:** Continuo 는 현재까지 **macOS** 에서만 실행 및 테스트되었습니다. Windows 와 Linux 는 아직 테스트되지 않았습니다 — 동작할 수도 있지만 거친 부분이 있을 수 있습니다. 제보와 수정 환영합니다.

**1 · 클론, 설치, 개발 빌드 실행**

Continuo는 형제 저장소 [ContinuoTerminal](https://github.com/philip1974/ContinuoTerminal)에 의존합니다 (`file:../ContinuoTerminal/...`로 참조하며 `.continuo-terminal-ref`에 기록된 커밋으로 고정). 두 저장소를 같은 디렉터리에 나란히 클론하세요:

```bash
git clone https://github.com/philip1974/Continuo.git
git clone https://github.com/philip1974/ContinuoTerminal.git
git -C ContinuoTerminal checkout "$(cat Continuo/.continuo-terminal-ref)"

cd Continuo
pnpm install
pnpm dev
```

`debug.*` 도구에는 저장소에 포함되지 않은 Microsoft js-debug 어댑터가 필요합니다. `node scripts/fetch-debug-adapter.mjs`로 한 번 내려받으세요 (버전 고정, 체크섬 검증). 패키지된 빌드에는 포함되어 있습니다. 어댑터가 있으면 `pnpm test`가 실제 디버거 테스트도 실행하므로, 먼저 테스트용 프로그램을 컴파일하세요: `pnpm exec tsc -p scripts/debug-spike/tsconfig.json`.

**2 · Continuo를 Claude Code의 MCP 서버로 연결**

Continuo는 stdio 브리지(`scripts/continuo-mcp-stdio.mjs`)를 함께 제공합니다. 이 브리지는 Unix 소켓 / Windows 명명 파이프를 통해 MCP 트래픽을 실행 중인 Continuo 앱으로 프록시합니다.

```bash
claude mcp add --transport stdio continuo -- /absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs
```

Windows에서는 Node로 실행하세요: `claude mcp add --transport stdio continuo -- node "C:\path\to\Continuo\scripts\continuo-mcp-stdio.mjs"`. 상태 표시줄의 **MCP 설정 복사** 버튼이 현재 플랫폼에 맞는 명령을 알려 줍니다.

MCP를 지원하는 다른 에이전트(예: Codex CLI)에도 같은 역할의 stdio MCP 서버 설정이 있습니다 — 같은 스크립트를 가리키면 됩니다.

Continuo 터미널 안에서는 bridge 가 항상 해당 터미널을 소유한 Continuo 인스턴스에 연결합니다(소켓 경로가 `CONTINUO_MCP_SOCKET` 으로 주입됨). 따라서 dev 빌드와 설치 버전을 함께 실행할 수 있습니다. Continuo 터미널 밖에서는 설치 버전을 먼저, 그다음 dev 빌드를 시도합니다. MCP 서버 설정에서 `CONTINUO_MCP_SOCKET` 을 명시적으로 지정하면 둘 다 무시하고 그 값을 사용합니다. macOS / Linux 에서 bridge 는 현재 사용자 소유의 소켓에만 연결하며, 소켓이 있는 디렉터리도 현재 사용자 소유이고 group / other 가 쓸 수 없어야 합니다(Continuo 가 만든 소켓은 항상 이 조건을 만족합니다). 명시한 값이 이 조건을 만족하지 않으면(다른 사용자의 소켓, `/tmp` 아래의 소켓, 해석된 대상이 위 조건을 만족하지 않는 심볼릭 링크) bridge 는 연결하지도, 창 토큰을 보내지도 않고 오류와 함께 즉시 종료합니다. Windows 에서는 명시한 값이 올바른 로컬 Continuo 파이프 이름(`\\.\pipe\continuo-mcp-…`)이어야 하며, 그 외의 값(원격 파이프, 임의 경로)이면 bridge 는 다른 후보로 넘어가지 않고 오류와 함께 즉시 종료합니다.

**3 · 에이전트가 UI를 구동하게 하기**

Continuo가 실행되고 MCP 서버가 등록되면, 에이전트는 다음을 호출할 수 있습니다:

| 도구 | 용도 |
|------|------|
| `terminal.create_session` | 새 터미널 패널 생성 (도킹 가능한 타일이 됨) |
| `terminal.send_text` | 세션에 텍스트 입력 |
| `terminal.send_input` | 세션에 입력 쓰기 — 쓰기 전에 LF→CR 및 리터럴 이스케이프(`\n` `\r` `\t` `\xHH`) 변환 (고급; `send_text` + `press_key` 권장) |
| `terminal.press_key` | 이름 있는 키 전송 (`enter`, `ctrl_c`, `tab`, `escape`, 방향키 등) |
| `terminal.read_output` | 지나간 출력 읽기 |
| `terminal.list_sessions` | 활성 패널 나열 |
| `terminal.kill` | 세션에 시그널 전송: `SIGTERM`(기본)은 Ctrl+C 후 3초 뒤 강제 종료, `SIGINT`는 Ctrl+C만 보냄(Continuo가 프로세스를 강제 종료하지 않음), `SIGKILL`은 즉시 종료. 프로세스가 끝나면 패널은 남고 `list_sessions`가 `exit_code`를 보고하며, 이때 출력 버퍼가 해제되므로 최종 출력이 필요하면 먼저 `read_output`을 호출하세요 |
| `terminal.await_stop_hook` | 세션의 에이전트가 Stop hook을 실행할 때(턴 종료)까지 대기; `install_stop_hook: true`, `agentLabel`이 `claude` / `claude-code` / `cc` / `codex`, cwd가 창의 workspace 폴더 안(홈 디렉터리나 그 상위 디렉터리는 제외)인 세션에만 hook이 설치됨 |
| `debug.*` | Node.js 디버거 제어: `launch`, `set_breakpoint`, `wait_for_stop`, `continue`, `step_over` / `step_in` / `step_out`, `stack`, `scopes`, `variables`, `evaluate`, `disconnect`, `list_sessions` |

에이전트가 창을 조작하기 전에 Continuo는 해당 창에서 허용 여부를 묻습니다. 터미널, 디버그, 플러그인 도구 권한은 각각 따로 부여됩니다. `list_sessions`는 창의 모든 세션을 보여 주지만, 읽기 / 쓰기 / kill / 대기 도구와 `debug.*`는 같은 MCP 호출자(stdio 연결 하나, 또는 HTTP 터미널 토큰 / MCP 세션 하나)가 `create_session` 또는 `debug.launch`로 만든 세션에만 동작합니다.

> **다중 사용자 호스트에서 디버깅할 때:** `debug.launch` 세션이 실행되는 동안 디버깅 중인 Node 프로세스의 inspector 는 `127.0.0.1` 의 임의 포트에서 대기합니다. 같은 머신의 다른 로컬 사용자는 누구나 이 포트에 접속해 디버기 안에서 당신의 권한으로 코드를 실행할 수 있습니다 — Continuo 고유가 아닌 Node / js-debug 의 일반적인 한계입니다. 다중 사용자 호스트에서는 `debug.launch` 를 신중히 사용하고, 끝나면 바로 세션을 끊으세요.

Claude Code에게 이렇게 물어보세요: *"패널 4개를 열고 각각 `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contract`, `pnpm typecheck` 를 실행해 줘 — 하나씩"* 그리고 그것이 일어나는 것을 지켜보세요.

## 설계 문서

문서는 코드 가까이에 둡니다:

- 코드 옆 하위 영역 README: `src/plugins/`, `src/marketplace/`, `src/shell/dock/`, `src/stores/`, `electron/main/`
- 인접 도구와의 포지셔닝 비교: [POSITIONING.md](POSITIONING.md)
- 코드베이스 작업하기: [CONTRIBUTING.md](CONTRIBUTING.md)
- 이 저장소에서 에이전트와 협업하기: [AGENTS.md](AGENTS.md)
- 보안 취약점 신고: [SECURITY.md](SECURITY.md)

## 라이선스

MIT — [LICENSE](LICENSE) 참고. 서드파티 컴포넌트 저작자 표시는 [LICENSE-3RD-PARTY.md](LICENSE-3RD-PARTY.md)에 있습니다.
