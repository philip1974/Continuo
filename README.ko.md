# Continuo — 터미널 네이티브 에이전트를 위한 오픈소스 GUI 기반

[English](README.md) · [简体中文](README.zh-CN.md) · **한국어**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/philip1974/Continuo)](https://github.com/philip1974/Continuo/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/philip1974/Continuo?style=social)](https://github.com/philip1974/Continuo)

Claude Code, Codex CLI, Aider 또는 직접 만든 에이전트를 도킹 가능한 멀티 터미널 GUI 안에서 실행하세요. 각 에이전트는 명시적인 플러그인별 권한 경계 안에서 동작합니다. **당신의 에이전트를 그대로 가져오세요.**

## 데모

실제 Claude Code가 Continuo의 MCP를 통해 Codex를 구동합니다 — Claude Code가 스스로 *두 번째* 터미널 패널을 열고, Codex에게 작업을 넘긴 뒤, 결과를 다시 읽어 옵니다. 이 모든 것이 하나의 창 안에서 이루어집니다:

![Continuo 데모 — 하나의 창에서 협업하는 Claude Code와 Codex](docs/assets/demo.gif)

▶️ [오디오 포함 / 고화질로 보기](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/continuo-demo.mp4)

## 다운로드

소스에서 빌드하지 않고 Continuo를 바로 써 보고 싶으신가요?

**macOS (Apple Silicon)** — 얼리 액세스, **서명되지 않은** 빌드:

- [DMG](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/Continuo-0.2.4-arm64.dmg)
- [ZIP 대체 다운로드](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/Continuo-0.2.4-arm64-mac.zip)
- [SHA256 체크섬](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/SHA256SUMS.txt)

release 페이지가 더 편하신가요? [최신 release 다운로드](https://github.com/philip1974/Continuo/releases/latest).

> 서명되지 않은 빌드: `.dmg`를 마운트한 뒤 Gatekeeper를 통과하려면 **앱을 우클릭 → 열기 → 열기**를 선택하세요. 코드 서명 / 공증은 이후 release에서 추가됩니다. Windows / Linux 빌드도 준비 중입니다. 소스에서 빌드하고 싶으신가요? 아래 **빠른 시작**을 참고하세요.

## 첫 실행 피드백

1. 위의 macOS Apple Silicon 빌드를 다운로드하세요.
2. 서명되지 않은 앱을 우클릭 -> 열기로 실행하세요.
3. 평소 쓰는 터미널 에이전트를 MCP stdio 브리지를 통해 연결하세요.
4. 무슨 일이 있었는지 알려 주세요: OS, 에이전트, 그리고 설치나 MCP가 깨진 정확한 단계.

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

**Node 24** 와 **pnpm** 이 필요합니다.

**1 · 설치 + dev 빌드 실행**

```bash
pnpm install
pnpm dev
```

**2 · Continuo를 Claude Code의 MCP 서버로 연결**

Continuo는 stdio 브리지(`scripts/continuo-mcp-stdio.mjs`)를 함께 제공합니다. 이 브리지는 Unix 소켓 / Windows 명명 파이프를 통해 MCP 트래픽을 실행 중인 Continuo 앱으로 프록시합니다.

```bash
claude mcp add --transport stdio continuo -- /absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs
```

Codex CLI / Aider 도 유사한 stdio-MCP 서버 설정이 있습니다 — 같은 스크립트를 가리키면 됩니다.

**3 · 에이전트가 UI를 구동하게 하기**

Continuo가 실행되고 MCP 서버가 등록되면, 에이전트는 다음을 호출할 수 있습니다:

| 도구 | 용도 |
|------|------|
| `terminal.create_session` | 새 터미널 패널 생성 (도킹 가능한 타일이 됨) |
| `terminal.send_text` | 세션에 텍스트 입력 |
| `terminal.press_key` | 이름이 지정된 키 전송 (Enter, Ctrl+C 등) |
| `terminal.read_output` | 스크롤되어 지나간 내용 읽기 |
| `terminal.list_sessions` | 활성 패널 열거 |
| `terminal.kill` | 패널 종료 |

Claude Code에게 이렇게 물어보세요: *"패널 4개를 열고 각각 `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contract`, `pnpm e2e` 를 실행해 줘 — 하나씩"* 그리고 그것이 일어나는 것을 지켜보세요.

## 설계 문서

아키텍처, 히스토리, ADR 심층 내용은 별도의 **ContinuoWiki** 저장소에 있습니다 (이 코드베이스 기준 읽기 전용). 이 README는 표면이고, wiki가 깊이입니다. 기여자를 위한 로컬 빠른 참조:

- 코드 가까이에 있는 하위 영역 README: `src/plugins/`, `src/marketplace/`, `src/shell/dock/`, `src/stores/`, `electron/main/`
- ADR: `doc/adr/`
- 인접 도구 대비 포지셔닝: [POSITIONING.md](POSITIONING.md)
- 코드베이스 작업하기: [CONTRIBUTING.md](CONTRIBUTING.md)
- 이 저장소에서 에이전트와 작업하기: [AGENTS.md](AGENTS.md)

## 라이선스

MIT — [LICENSE](LICENSE) 참고. 서드파티 컴포넌트 저작자 표시는 [LICENSE-3RD-PARTY.md](LICENSE-3RD-PARTY.md)에 있습니다.
