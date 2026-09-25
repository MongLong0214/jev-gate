# jev-gate 구현 지침 (V5 + lean)

명세는 GitHub 이슈가 소유한다. **현재 이슈 본문이 정본이고, 과거 댓글·HANDOFF·폐기된 요구는 정본이 아니다.**

- **lean (`jev-lean-handoff-v1.1`, 진행 중)**: [#21 PRD](https://github.com/MongLong0214/jev-gate/issues/21) → [#22 ADR](https://github.com/MongLong0214/jev-gate/issues/22) → [#33](https://github.com/MongLong0214/jev-gate/issues/33) → [#34](https://github.com/MongLong0214/jev-gate/issues/34) → [#35](https://github.com/MongLong0214/jev-gate/issues/35) → [#36](https://github.com/MongLong0214/jev-gate/issues/36), 측정은 [#29](https://github.com/MongLong0214/jev-gate/issues/29).
- **legacy 라우팅(off/native/auto)**: [#23](https://github.com/MongLong0214/jev-gate/issues/23)~[#31](https://github.com/MongLong0214/jev-gate/issues/31). ADR 본문의 r2 개정(A1–A16)이 그보다 앞선 문장을 덮어쓴다. #1–#18은 V3·V4 역사 기록이다.

추가 PRD 사본·승인 JSON·문서 validator·review ledger·오케스트레이션 프레임워크를 만들지 않는다.

`lean`은 legacy와 **분리된 경로**다. Gate A/B/C, planner, task graph, tier routing, depth floor, root guard, plan
interpretation 중 어느 것도 lean에서 실행되지 않는다. 공유하는 것은 디스패처·상태 파일·락·trace·TypeSafe 클라이언트뿐이다.

## 구조

호스트 중립 코어와 Claude Code 어댑터를 구분한다. 코어에는 벤더 모델 이름이 들어가지 않는다(V6 Codex 어댑터가 같은 정책을 그대로 쓴다).

| 경로 | 층 | 역할 |
| --- | --- | --- |
| `src/types.ts` | 코어 | tier(fast/standard/deep/frontier), 6개 owned agent 매핑, ConfigV5, PlannedTask/PlannerReply/WorkerReply, JobState, 닫힌 코드 유니온 |
| `src/config.ts` | 코어 | ConfigV5(version 5, 기본 off). V3·V4 레이아웃은 거부 + 마이그레이션 샘플 |
| `src/jev.ts` | 코어 | 고정 endpoint POST 1회, headers+body 단일 deadline, retry 0, Choice 엄격 검증, tier 설명 텍스트 |
| `src/admission.ts` | 코어 | Gate A 질문과 판정(direct/orchestrated/needs_context/abstain, floor 미달은 direct 보존) |
| `src/allocation.ts` | 코어 | Gate B(planner tier, worker tier + upgrade_basis), Gate C(result, advisory) 질문과 판정 |
| `src/plan.ts` | 코어 | JSON 추출·검증, `contract_hash`, `[JEV_TASK rev=<n> id=<id> attempt=<n>]` 마커, 계약 합성, 결정적 수락 판정 |
| `src/job.ts` | 코어 | `(session_id, prompt_id)` 세대별 상태 파일, 예약, 상한, 히스토리. 0700/0600, 원자적 쓰기, symlink 거부, pid 기반 stale lock |
| `src/coordinator.ts` | 코어 | 고정 지침·거부 사유·컨텍스트 문구. `JEV_GATE_EXPERIMENT_ADMISSION`은 벤치 강제 오케스트레이션 전용 |
| `src/hook.ts` | 어댑터 | 이벤트 디스패치. `JEV_GATE_MODE=off`는 상태·config 읽기 전에 종료 |
| `src/brief.ts` | 어댑터 | 적격성, allow-list 가드, 입력 패치(원문이 정확한 prefix), 출력 ≤512 KiB |
| `src/lean-source.ts` | 어댑터 | (lean) 호스트 transcript 어댑터. compact lineage(`compactMetadata.preservedSegment`), human/tool_result 구분, 그룹화, prefix digest, 비밀정보 선별 |
| `src/lean.ts` | 코어 | (lean) work_shape·handoff_scope·relation_<id> 한 배치 구성, 판정, packet 합성, `recent_packet` 결정적 recency 규칙 |
| `src/cli.ts` | 어댑터 | `doctor` + `explain`. 추론 0 |
| `hooks/hooks.json`, `agents/*.md` | 어댑터 | (legacy) UserPromptSubmit·PreToolUse(matcher 없음)·PostToolUse/Failure(`^Agent$`)·Stop; worker 4종 + planner 2종, 모두 Agent·SendMessage 금지 |
| `hooks/lean.json`, `agents/executor.md` | 어댑터 | (lean) UserPromptSubmit + Agent 전용 Pre/Post/Failure, entrypoint `dist/hook.js --lean`; executor 1종, `model: inherit`, Agent·SendMessage 금지 |
| `src/bench/{run,report,paths,checker,usage}.ts` | 도구 | legacy 8 arm + `--arms lean`(native_auto/recent_packet/jev_lean) 실행기(계획=stdout만, 실행=배타적 새 out + 입력 동결 + 셀별 state dir + 부모 환경 차단), 계획 우선 보고, checker 프로토콜 |
| `mods/router/` | Mod | (router, #40–#43) Function Hooks 플러그인 `jev-gate-router`. 기본 off. root turn의 effort(선택적으로 model)와 상속형 built-in subagent의 model만 바꾼다. 비밀정보 패턴은 `src/lean-source.ts`의 사본이고 `tests/router/secret-parity.test.ts`가 일치를 강제한다. 타입은 `mods/tsconfig.json`, 테스트는 `tests/router/`(vitest)와 `mods/router/tests/`(호스트 키트), 패키지는 `pack --profile router` |
| `bench/v5/`, `bench/v4/` | 도구 | 평가 job·checker·reference. V4는 개발 데이터로 보존 |
| `bench/results/` | 기록 | 공개 가능한 집계만. 원자료는 저장소 밖 |

## 규칙

- hook는 언제나 exit 0. 오케스트레이션이 활성일 때의 root 가드만 `permissionDecision: "deny"`를 반환하고, `allow`는 절대 반환하지 않는다. 패치는 `updatedInput`으로 전체 입력을 돌려주며 권한을 승인하지 않는다.
- 가드는 allow-list다. 목록 밖 도구는 고정 사유로 거부하고, 한 프롬프트에서 예산을 소진하면 `continue:false`로 끝낸다. child 호출(`agent_id` 있음)은 절대 가드하지 않는다.
- 수락은 코드가 소유한다. `done` + blockers 없음 + 모든 required check가 정확히 한 번 `pass`여야 의존 작업이 열린다. Gate C는 자문이며 readiness를 바꾸지 못한다.
- 불확실·invalid·timeout·키 없음은 **원래 호출 보존**. 낮은 confidence를 상위 tier로 올리지 않는다. deep/frontier는 구체적 upgrade basis가 있어야 한다. abstain은 호출된 프로필을 유지한다.
- `prompt_id`가 없으면 오케스트레이션도 가드도 없다. 새 프롬프트는 이전 세대를 히스토리로 밀어내고, 늦게 도착한 결과는 기록만 하며 현재 계획을 진행시키지 않는다. HTTP 후에는 세대와 rev를 다시 확인한 뒤 적용한다.
- TypeSafe로 가는 것: auto에서 사용자 요청(Gate A), 합성된 task 계약과 선행 결과 요약(Gate B), worker 구조화 응답(Gate C). 저장소·transcript·credential을 훅이 스스로 읽지 않는다. 키는 Authorization 헤더 외 어디에도 없다. 신뢰 순서는 사용자 제약·네이티브 권한 > 계약 > worker 보고 사실 > route note.
- 회계: intent 기록이 없으면 "안 보냄"이 아니라 "모름". 실패 후에도 소비는 가능. 빈 usage는 0이 아니다. 요청한 프로필·실제 모델·실제 effort는 서로 다른 사실이다. haiku는 frontmatter effort가 적용되지 않는다(2026-09-18 관측).
- 벤치: 계획 행이 분모. 누락 파일은 not_started가 아니다. 측정 세션은 부모 환경을 상속하지 않는다(`CLAUDE_*` 제거). 유리한 결과 선택·checker 사후 조정 금지(결함은 기록하고 전원 재채점, 이력 보존). arm을 뺄 때는 결과를 보기 전에 근거를 기록한다.
- 변경 후 `npm run typecheck && npm test && npm run build && claude plugin validate . --strict`를 실제 실행하고 결과를 그대로 보고한다. 테스트는 fake HTTP·fake CLI만 사용하며 키/로그인이 필요 없다.
- lean: 키 없음·off·source 불명·선별 대상 없음은 HTTP 이전에 native로 끝낸다. 실제 생략이 없으면 `no_effect`이고 지불한 호출 비용은 남긴다. packet은 root additionalContext에 넣지 않는다. PreToolUse는 `updatedInput`으로 원본 전체를 돌려주고 `allow`를 반환하지 않으며, 해결 불가 marker는 deny한다. 활성 executor는 root 세션당 하나이고, 관측된 terminal 이벤트만 예약을 해제한다.
- 구현 완료 / 설치 호스트 관측 / 측정된 제품 효과는 서로 다른 완료다. packet이 작아진 것, Jev를 호출한 것, 테스트가 통과한 것을 "토큰이 줄었다"로 바꾸어 보고하지 않는다. 요청 없이 release/npm publish/marketplace/홍보를 하지 않는다.
