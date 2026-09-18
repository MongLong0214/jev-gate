# jev-gate 구현 지침 (V4)

명세는 GitHub 이슈가 소유한다: [#9 PRD](https://github.com/MongLong0214/jev-gate/issues/9) → [#10 ADR](https://github.com/MongLong0214/jev-gate/issues/10) → [#11](https://github.com/MongLong0214/jev-gate/issues/11)~[#18](https://github.com/MongLong0214/jev-gate/issues/18). #1–#8은 역사 기록이다. 추가 PRD 사본·승인 JSON·문서 validator·review ledger·오케스트레이션 프레임워크를 만들지 않는다.

## 구조

| 경로 | 역할 |
| --- | --- |
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | 매니페스트; `UserPromptSubmit` 1개 + `^Agent$`에 `PreToolUse`/`PostToolUse`/`PostToolUseFailure` 각 1개, 모두 `node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"` timeout 5 |
| `agents/worker.md`, `agents/planner.md` | `jev-gate:worker`(sonnet, Read/Grep/Glob/Edit/Write/Bash), `jev-gate:planner`(opus, Read/Grep/Glob); 둘 다 Agent·SendMessage 금지 |
| `src/hook.ts` | 이벤트 디스패치. `JEV_GATE_MODE=off`는 config 읽기 전에 종료. UserPromptSubmit=고정 지침(Jev 0), PreToolUse:Agent=적격성→Jev 최대 1회→전체 입력 패치 또는 보존, Post*=관측만 |
| `src/brief.ts` | `checkEligibility`(#10 §4), `patchAgentInput`(원문이 정확한 prefix, model/prompt만 변경), suffix ≤1 KiB, 출력 ≤512 KiB |
| `src/jev.ts` | 고정 endpoint POST 1회, headers+body 단일 deadline, retry 0, Choice 엄격 검증, `decideTask`(context 우선, abstain/동률/floor 미달=보존) |
| `src/coordinator.ts` | 공통 지침 + 모드 문장. `JEV_GATE_EXPERIMENT_ALLOCATION`은 벤치 고정 역할 control 전용 |
| `src/config.ts` | ConfigV4(version 4, off/native/auto 기본 off). V3 레이아웃은 거부 + 마이그레이션 샘플 |
| `src/trace.ts` | opt-in 로컬 기록: phase별 파일, 0700/0600, 원자적 쓰기, symlink 거부, 조인 키는 파일 안에 |
| `src/auth.ts` | 엄격한 `claude auth status` 파서(정상 종료+JSON 객체), SUBAGENT_MODEL override 분류 |
| `src/cli.ts` | `doctor`만. 추론 0 |
| `src/bench/{run,report,paths,checker,usage}.ts` | 5 arm 실행기(계획=stdout만, 실행=배타적 새 out+입력 동결+dispatch intent), 계획 우선 보고, 안전 경로/스냅샷, checker 프로토콜, 엄격 숫자 |
| `bench/v4/` | V4 평가 job 4개(fixture·checker·reference). `bench/` 루트의 4개는 V3 개발 fixture |
| `bench/results/` | run-1(V3)·v4-host 관측 등 공개 가능한 집계만. 원자료는 저장소 밖 |

## 규칙

- hook는 exit 0만. `permissionDecision`/`decision:block`/`continue:false`/exit 2 금지. 패치는 `updatedInput`로 전체 입력을 돌려주고 권한을 승인하지 않는다.
- 적격 조건 전부 충족 시에만 Jev 1회. 명시 model(null/빈 문자열 포함)·resume/name/team/isolation·child 호출·다른 agent·background·구체적 `CLAUDE_CODE_SUBAGENT_MODEL`/FORCE·fork 강제는 무조건 보존. `run_in_background` 부재는 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`일 때만 foreground로 본다(2.1.275 관측).
- 불확실·invalid·timeout·키 없음은 **원래 입력 보존**. 낮은 confidence를 Fable로 올리지 않는다.
- TypeSafe로 가는 것은 위임 prompt/description과 고정 criteria다(코드·이전 제약 포함 가능). 저장소·transcript·credential을 훅이 스스로 읽지 않는다. 키는 Authorization 헤더 외 어디에도 없다.
- 회계: intent 기록이 없으면 "안 보냄"이 아니라 "모름". 실패 후에도 소비는 가능. 빈 usage는 0이 아니다. Fable 0은 완전한 모델 식별이 있을 때만.
- 벤치: 계획 행이 분모. 누락 파일은 not_started가 아니다. 유리한 결과 선택·checker 사후 조정 금지(결함은 기록하고 전원 재채점, 이력 보존).
- 변경 후 `npm run typecheck && npm test && npm run build && claude plugin validate . --strict`를 실제 실행하고 결과를 그대로 보고한다. 테스트는 fake HTTP·fake CLI만 사용하며 키/로그인이 필요 없다.
- 구현 완료 / 설치 호스트 관측 / 측정된 제품 효과는 서로 다른 완료다. 요청 없이 release/npm publish/marketplace/홍보를 하지 않는다.
