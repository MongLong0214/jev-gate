# jev-gate 구현 지침 (V5)

명세는 GitHub 이슈가 소유한다. **현재 이슈 본문이 정본이고, 과거 댓글·HANDOFF·폐기된 요구는 정본이 아니다.**

- lean: [#217](https://github.com/MongLong0214/jev-gate/issues/217)에서 철회·삭제. 과거 명세(#21~#36)는 역사 기록이다.
- **legacy 라우팅(off/native/auto)**: [#23](https://github.com/MongLong0214/jev-gate/issues/23)~[#31](https://github.com/MongLong0214/jev-gate/issues/31). ADR 본문의 r2 개정(A1–A16)이 그보다 앞선 문장을 덮어쓴다. #1–#18은 V3·V4 역사 기록이다.

추가 PRD 사본·승인 JSON·문서 validator·review ledger·오케스트레이션 프레임워크를 만들지 않는다.

## 구조

호스트 중립 코어와 Claude Code 어댑터를 구분한다. 코어에는 벤더 모델 이름이 들어가지 않는다(V6 Codex 어댑터가 같은 정책을 그대로 쓴다).

| 경로 | 층 | 역할 |
| --- | --- | --- |
| `src/types.ts` | 코어 | tier(fast/standard/deep/frontier), 4개 owned worker 매핑, ConfigV5, PlannedTask(Gate B 입력)/WorkerReply, JobState, 닫힌 코드 유니온 |
| `src/agents.ts` | 코어 | `OWNED_AGENT_PROFILES`(#48): file/role/tier/effort/tools 단일 테이블. `model`은 없음 -- `DEFAULT_CONFIG.models[tier]`를 읽는다. doctor·`gen-agents.mjs`가 이 테이블 하나를 읽는다 |
| `src/config.ts` | 코어 | ConfigV5(version 5, 기본 off). `models.frontier` 기본값 opus(#48, 과거 fable). #289로 삭제된 planner·가드·`workerIsolation` 키(`IGNORED_KEYS`)는 오류 없이 무시하고 doctor가 info로 알린다. V3·V4 레이아웃은 거부 + 마이그레이션 샘플 |
| `src/jev.ts` | 코어 | 고정 endpoint POST 1회, headers+body 단일 deadline, retry 0, Choice 엄격 검증, tier 설명 텍스트 |
| `src/recent-prompts.ts` | 어댑터 | (#115) Gate A가 `needs_context`를 내면 transcript 꼬리에서 사용자가 직접 입력한 최근 3턴(tool_result·meta·sidechain·커맨드 제외, 비밀정보 의심 턴은 드롭)을 읽어 현재 프롬프트와 함께 1회 재판정. 두 번째 admission_result에 `context_turns` 기록 |
| `src/admission.ts` | 코어 | Gate A 질문과 판정(direct/orchestrated/needs_context/abstain, floor 미달은 direct 보존) |
| `src/allocation.ts` | 코어 | Gate B(worker tier + upgrade_basis) 질문과 판정 |
| `src/plan.ts` | 코어 | JSON 추출, 단일 워커 프롬프트 합성(사용자 원문 동봉), WorkerReply 파싱, 워커 보고 기반 수락 판정, Gate B용 라우팅 대상 마스킹 |
| `src/job.ts` | 코어 | `(session_id, prompt_id)` 세대별 상태 파일, 예약, 상한, 히스토리. 0700/0600, 원자적 쓰기, symlink 거부, pid 기반 stale lock |
| `src/liveness.ts` | 코어 | (#48) `<stateRoot>/jev-gate/liveness.json` 링버퍼(cap 50), auto 모드 admission 판정마다 1건. job.ts와 같은 파일 쓰기 패턴(0700/0600, tmp+rename, symlink 거부). 락 없음(동시 세션은 갱신 유실 가능, 의도적) |
| `src/coordinator.ts` | 코어 | 고정 지침·거부 사유·컨텍스트 문구. `JEV_GATE_EXPERIMENT_ADMISSION`은 벤치 강제 오케스트레이션 전용. admitted 턴은 단일 워커 지침 하나(#289) |
| `src/host-window.ts` | 어댑터 | (#48) 호스트 auto-compaction window 판독: env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` → cwd `.claude/settings.local.json`/`settings.json` → 사용자 settings.json. `effectiveDepthFloor`(src/config.ts)가 이 값을 소비 |
| `src/entry.ts` | 어댑터 | (#48) `dist/entry.js`. gate 모듈 static import 0개. `JEV_GATE_MODE=off` 또는 config 파일 `mode:"off"`면 stdin 소비 후 즉시 종료, 아니면 `./hook.js`를 동적 import해 `main()` 호출. hooks.json이 가리키는 실제 진입점 |
| `src/hook.ts` | 어댑터 | 이벤트 디스패치. `JEV_GATE_MODE=off`는 상태·config 읽기 전에 종료. `main()` export를 자기 main-module 블록과 entry.ts 양쪽에서 호출. job state가 없는 native Agent 호출도(#48) `post`/`failure` trace에 `subagent_type`/`requested_model`/`resolved_model` 기록(과거엔 기록 없이 skip) |
| `src/brief.ts` | 어댑터 | 적격성, 입력 패치(원문이 정확한 prefix), 출력 ≤512 KiB. `renderSystemMessage`(#48)는 모델 컨텍스트로 가지 않는 SessionStart 알림 전용. 루트 도구 가드는 #289로 삭제: 루트의 Agent 외 PreToolUse는 판정하지 않는다 |
| `src/outbound-text.ts` | 코어 | 호스트 중립 송신 텍스트 선별: `looksSecret` 비밀정보 스크린, `estimateTokens`. Evidence·recent-prompts가 쓰고 `src/router-secret.ts`가 미러링 |
| `src/cli.ts` | 어댑터 | `doctor` + `explain`. 추론 0. (#48) doctor는 host window·effective floor·liveness도 같은 FAIL/WARN 기준으로 보고. doctor는 `OWNED_AGENT_PROFILES`+`DEFAULT_CONFIG.models`에서 파생된 기대값과 설치된 frontmatter 불일치, 그리고 유효 config의 `models.<tier>`와 설치된 frontmatter의 family 불일치(#48)를 각각 fail 처리 |
| `hooks/hooks.json`, `agents/*.md` | 어댑터 | (legacy) UserPromptSubmit·PreToolUse(matcher 없음, 백그라운드 워커 종료 대조용)·PostToolUse/Failure(`^Agent$`)·Stop·SessionStart(#48, matcher 없음); worker 4종, 모두 Agent·SendMessage 금지. 커맨드는 `dist/entry.js`(#48) |
| `src/bench/ab.ts` | 도구 | (#130) 설치된 플러그인의 짝지은 A/B 벤치: 4조건(A off/B Gate/C Compact/D all)×2턴(프라이밍→`--resume`)×조건 순서 회전. 타임아웃·영구 out 디렉토리·git worktree 정리·셀별 시각 기록. `report`는 ok 셀 중앙값+cache_create/read 분리+짝지은 부호 판정. 해석 주의는 `docs/bench-ab.md` |
| `src/bench/{run,report,paths,checker,usage}.ts` | 도구 | legacy 8 arm 실행기(계획=stdout만, 실행=배타적 새 out + 입력 동결 + 셀별 state dir + 부모 환경 차단), 계획 우선 보고, checker 프로토콜 |
| `hooks/register.ts` | 어댑터 | (v0.6.0) 한 plugin의 유일한 Function Hooks 모듈. compact·router의 `registerX(on, config)`를 부르고, 옵션 이름을 `OPTION_NAMES`로 각 Mod 이름으로 바꾸며, 옵션 오류 진단은 `session.start` 하나에서 쓴다(호스트는 모듈 하나·이벤트당 등록 하나만 받는다). `plugin.json` userConfig는 `tests/plugin-modules.test.ts`가 각 Mod manifest와 일치시킨다 |
| `mods/router/` | Mod | (router, #40–#43) Function Hooks Mod, v0.6.0부터 `jev-gate` plugin 안에서 로드(단독 `--plugin-dir`는 개발·벤치용 `jev-gate-router`). 기본 on (`routerEnabled` true, v0.6.3). root의 실제 모델·effort 조합과 일반 subagent를 라우팅한다(#143–151). Gate B는 기존 배치에서 배정한다. Astra/Fable 자동 타깃은 각 호스트의 기존 opt-in boolean true일 때만 허용한다. 단독 개발은 pack --profile router로 추출한 디렉터리를 --plugin-dir로 로드한다. 비밀정보 패턴은 `src/outbound-text.ts`의 `looksSecret` 사본(`src/router-secret.ts`)이고 `tests/router/secret-parity.test.ts`가 일치를 강제한다. 타입은 `mods/tsconfig.json`, 테스트는 `tests/router/`(vitest)와 `mods/router/tests/`(호스트 키트), 패키지는 `pack --profile router` |
| `bench/v5/`, `bench/v4/` | 도구 | 평가 job·checker·reference. V4는 개발 데이터로 보존 |
| `bench/results/` | 기록 | 공개 가능한 집계만. 원자료는 저장소 밖 |

## 규칙

- hook는 언제나 exit 0. 오케스트레이션이 활성일 때의 root 가드만 `permissionDecision: "deny"`를 반환하고, `allow`는 절대 반환하지 않는다. 패치는 `updatedInput`으로 전체 입력을 돌려주며 권한을 승인하지 않는다.
- 가드는 allow-list다. 목록 밖 도구는 고정 사유로 거부하고, 한 프롬프트에서 예산을 소진하면 `continue:false`로 끝낸다. child 호출(`agent_id` 있음)은 절대 가드하지 않는다.
- 수락은 코드가 소유한다. `done` + blockers 없음 + 모든 required check가 정확히 한 번 `pass`여야 의존 작업이 열린다.
- 불확실·invalid·timeout·키 없음은 **원래 호출 보존**. 낮은 confidence를 상위 tier로 올리지 않는다. deep/frontier는 구체적 upgrade basis가 있어야 한다. abstain은 호출된 프로필을 유지한다.
- `prompt_id`가 없으면 오케스트레이션도 가드도 없다. 새 프롬프트는 이전 세대를 히스토리로 밀어내고, 늦게 도착한 결과는 기록만 하며 현재 계획을 진행시키지 않는다. HTTP 후에는 세대와 rev를 다시 확인한 뒤 적용한다.
- TypeSafe로 가는 것: auto에서 사용자 요청(Gate A; `needs_context` 재판정 1회에는 최근 사용자 입력 3턴이 함께 간다, #115), 합성된 task 계약과 선행 결과 요약(Gate B). 저장소·transcript·credential을 훅이 스스로 읽지 않는다. 키는 Authorization 헤더 외 어디에도 없다. 신뢰 순서는 사용자 제약·네이티브 권한 > 계약 > worker 보고 사실 > route note.
- 회계: intent 기록이 없으면 "안 보냄"이 아니라 "모름". 실패 후에도 소비는 가능. 빈 usage는 0이 아니다. 요청한 프로필·실제 모델·실제 effort는 서로 다른 사실이다. haiku는 frontmatter effort가 적용되지 않는다(2026-09-18 관측). job state가 없다고 기록을 안 남기지 않는다(#48) -- root-caller Agent 호출은 job 유무와 무관하게 `off` 모드를 제외한 모든 모드에서 `requested_model`/`resolved_model`/`subagent_type`을 trace에 남긴다.
- 벤치: 계획 행이 분모. 누락 파일은 not_started가 아니다. 측정 세션은 부모 환경을 상속하지 않는다(`CLAUDE_*` 제거). 유리한 결과 선택·checker 사후 조정 금지(결함은 기록하고 전원 재채점, 이력 보존). arm을 뺄 때는 결과를 보기 전에 근거를 기록한다.
- 변경 후 `npm run typecheck && npm test && npm run build && claude plugin validate . --strict`를 실제 실행하고 결과를 그대로 보고한다. 테스트는 fake HTTP·fake CLI만 사용하며 키/로그인이 필요 없다.
- 구현 완료 / 설치 호스트 관측 / 측정된 제품 효과는 서로 다른 완료다. packet이 작아진 것, Jev를 호출한 것, 테스트가 통과한 것을 "토큰이 줄었다"로 바꾸어 보고하지 않는다. 요청 없이 release/npm publish/marketplace/홍보를 하지 않는다.
