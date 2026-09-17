# jev-gate 구현 지침

명세는 GitHub 이슈가 소유한다: [#1 PRD](https://github.com/MongLong0214/jev-gate/issues/1) → [#2 ADR](https://github.com/MongLong0214/jev-gate/issues/2) → [#3](https://github.com/MongLong0214/jev-gate/issues/3) hook → [#4](https://github.com/MongLong0214/jev-gate/issues/4) Jev/Brief → [#5](https://github.com/MongLong0214/jev-gate/issues/5) agents → [#6](https://github.com/MongLong0214/jev-gate/issues/6) bench → [#7](https://github.com/MongLong0214/jev-gate/issues/7) 납품. 추가 PRD 사본·승인 JSON·문서 validator·review ledger를 만들지 않는다.

## 구조

| 경로 | 역할 |
| --- | --- |
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | 플러그인 매니페스트, UserPromptSubmit command hook 1개 (`node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"`, timeout 5) |
| `agents/opus.md`, `agents/frontier.md` | native subagent → `jev-gate:opus`(model opus), `jev-gate:frontier`(model fable) |
| `src/hook.ts` | `readHookInput → loadConfig → splitLossless → callJev → decide → renderAdditionalContext → stdout JSON` |
| `src/blocks.ts` | lossless UTF-16 블록 분할(줄/fence 보존, 최대 24) |
| `src/jev.ts` | 고정 endpoint POST 1회, Choice 검증, 라우팅 결정. 질문 문구는 이 파일 한 곳 |
| `src/brief.ts` | Brief 렌더러(8 KiB 초과 시 인용→offset 참조), 중립 fallback 문구 |
| `src/config.ts` | v3 config 로딩/검증, `JEV_GATE_MODE`/`JEV_GATE_CONFIG` |
| `src/cli.ts` | `doctor`만. 추론 0 |
| `src/bench/run.ts`, `report.ts`, `usage.ts` | 네 arm 실행기(공식 CLI 외부 실행), 보고(파일만 읽음), modelUsage 합산 |
| `bench/` | fixture·checker·reference·manifest |
| `tests/` | Vitest. fake HTTP·fake `claude`만 사용, 키/로그인 불필요 |

## 규칙

- hook는 exit 0만 사용한다. `decision:block`, `continue:false`, exit 2를 쓰지 않는다. 실패는 고정 중립 문구, 지원하지 않는 입력은 무출력.
- TypeSafe로 보내는 것은 이번 prompt 블록과 고정 criteria만. transcript·source·env·credential을 읽거나 보내지 않는다.
- Jev는 재시도 0, deadline 1개(headers+body), redirect 금지. 키는 Authorization 헤더 외 어디에도 나타나지 않는다(로그·trace·stderr 포함).
- hook 내부에서 child_process·Claude CLI·다른 생성 API를 호출하지 않는다. 벤치만 별도 프로세스에서 공식 `claude -p`를 실행한다.
- 모델/endpoint 문자열은 신뢰된 config에서만 온다. prompt나 Jev 응답이 이를 바꿀 수 없다.
- 에러 코드는 `src/types.ts`의 `ErrorCode` 고정 집합만 stderr에 쓴다. 공급자 자유형 오류를 context에 넣지 않는다.
- 벤치는 실패·fallback·권고/실제 불일치·미측정(null)을 삭제하지 않는다. 분모는 계획 셀 수다.
- 변경 후 `npm run typecheck && npm test && npm run build && claude plugin validate . --strict`를 실제 실행하고 결과를 그대로 보고한다.
- 구현 완료, 오프라인 회귀, 설치 호스트 live 확인, 실제 절감 관측은 서로 다른 완료다. 요청 없이 release/npm publish/홍보를 하지 않는다.

`frontier-simplify` 참고: https://github.com/MongLong0214/frontier-simplify/blob/96b07ad17e90fd4e69e1a7748641d7f30c06fcf0/skills/frontier-simplify/SKILL.md . 원리는 적용하되 별도 검증 framework를 이식하지 않는다.
