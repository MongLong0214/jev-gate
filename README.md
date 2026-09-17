# jev-gate

**Jev로 요청을 분류한 뒤 worker 또는 frontier 생성 모델에 보내면, 전체 비용과 응답 시간이 줄어드는가?**

현재 상태: **MVP 구현 명세와 시작 파일**. 실행기·스킬·벤치는 아래 이슈에 따라 구현할 대상입니다. 아직 라이브 API 연결이나 절감률을 검증한 제품이 아닙니다.

## 에이전트 시작점

[**#1 PRD**](https://github.com/MongLong0214/jev-gate/issues/1) → [**#2 ADR**](https://github.com/MongLong0214/jev-gate/issues/2) → [**#3 첫 개발 티켓**](https://github.com/MongLong0214/jev-gate/issues/3).

| 이슈 | 책임 |
|---|---|
| [#1 JG-PRD](https://github.com/MongLong0214/jev-gate/issues/1) | 목표·범위·진행 순서 |
| [#2 JG-ADR](https://github.com/MongLong0214/jev-gate/issues/2) | 인증·HTTP·타입·비용·시간 계약 |
| [#3 JG-01](https://github.com/MongLong0214/jev-gate/issues/3) | CLI·설정·plan·원자료 저장 |
| [#4 JG-02](https://github.com/MongLong0214/jev-gate/issues/4) | Jev·생성 API·사용량 |
| [#5 JG-03](https://github.com/MongLong0214/jev-gate/issues/5) | 단일 Choice 라우팅 |
| [#6 JG-04](https://github.com/MongLong0214/jev-gate/issues/6) | 세 모드 벤치·정답·보고 |
| [#7 JG-05](https://github.com/MongLong0214/jev-gate/issues/7) | 얇은 스킬·설치·실제 연결 확인 |

GitHub 이슈가 구현 명세입니다. 같은 PRD/ADR 사본이나 승인 시스템을 다시 만들지 않습니다.

## MVP 동작

```text
prompt + context
  → Jev Choice 1회: worker / frontier / uncertain
  → 선택된 생성 API 1회
  → answer + usage + cost + latency
```

비교 모드: `frontier` 단독 / `worker` 단독 / `gated`.

Jev는 답변을 생성하거나 다른 모델을 대신 호출하지 않습니다. **우리 코드가 Jev의 결과를 읽고 다음 HTTP 호출을 수행**합니다. uncertainty/error는 명세의 frontier fallback으로 처리하고, 생성 실패 후 반복 생성은 하지 않습니다.

## API 키는 어떻게 연결하나?

| 환경변수 예시 | 발급처와 용도 |
|---|---|
| `TYPESAFE_API_KEY` | TypeSafe console의 Jev 인증 |
| `WORKER_API_KEY` | 사용자의 무료/저가 생성 API 인증 |
| `FRONTIER_API_KEY` | 프론티어 생성 API 제공자 인증 |

세 역할이지 반드시 세 계정은 아닙니다. 같은 생성 API 계정으로 두 모델을 쓸 수 있다면 두 설정에서 같은 env 이름을 참조할 수 있습니다. 다른 생성 API 키가 TypeSafe 키를 대신하지는 않습니다.

Jev native endpoint는 `POST https://api.typesafe.ai/v1/systemone`, 인증은 `Authorization: Bearer ...`, body는 `model/state/questions`입니다. 생성 모델의 Chat Completions와 요청 형식이 다릅니다.

`.env.example`을 로컬 `.env`로 복사하고 키는 로컬에서만 입력합니다. 값은 채팅·이슈·Git에 게시하지 않습니다. `examples/config.example.json`을 `local.json`으로 복사해 실제 provider URL/model/profile/지원 출력 한도를 채웁니다. 미정 값은 의도적으로 비어 있습니다. 가격은 기본 `unknown`이며 무료 계정 조건도 확인 후 설정합니다.

## 구현 후 사용할 인터페이스

다음은 **#3–#7에서 구현하고 확인할 명령**이며 현재 scaffold에서 실행된다는 뜻이 아닙니다.

```sh
npm ci
npm run build
# 계획: HTTP 호출 없음
node dist/cli.js run --input examples/request.json --config local.json --mode gated
# 실제 요청: 명시적 실행과 새 출력 경로 필요
node --env-file=.env dist/cli.js run --input examples/request.json \
  --config local.json --mode gated --out artifacts/one --execute
# 6개 예제 × 최대 4 POST = 최대 24개 추론 요청
node --env-file=.env dist/cli.js bench --cases examples/smoke-cases.jsonl \
  --config local.json --out artifacts/smoke --seed 42 --max-calls 24 --execute
# 보존한 자료만 재계산
node dist/cli.js report --run artifacts/smoke
```

`--max-calls`는 client 요청 수 제한이며 USD 청구 한도가 아닙니다. 모든 live 호출은 기존에 허가된 계정·데이터·예산 안에서만 수행합니다.

## 범위와 결과 해석

Node.js 22+ / TypeScript / native fetch. 첫 버전은 자체완결 텍스트 요청만 처리합니다. UI·DB·MCP·모델 학습·컨텍스트 압축·리뷰 루프·생성 코드 실행은 없습니다.

스킬은 이 CLI를 부르는 안내입니다. 이미 실행된 호스트 모델의 비용을 없애지는 않습니다. confidence는 답변 정확도 보증이 아닙니다. 무료 모델 단독이 더 낫거나 gated가 느리고 비싸지면 그대로 보고합니다. 실패·미시작·미측정 비용을 성공적인 절약으로 세지 않습니다.

예제 여섯 개는 연결 확인용이며 일반 성능을 입증하는 평가셋이 아닙니다. artifacts에는 비공개 입력·응답이 있을 수 있으므로 자동 업로드하지 않습니다.

## 공식 자료

2026-09-17 검토. 정확한 계약과 범위는 #2/#4에 기록했습니다.

- [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt)
- [HTTP API](https://docs.typesafe.ai/api.md)
- [Choice](https://docs.typesafe.ai/primitives/choice.md) · [Confidence](https://docs.typesafe.ai/confidence.md)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md)
- [frontier-simplify, 검토 ref](https://github.com/MongLong0214/frontier-simplify/blob/96b07ad17e90fd4e69e1a7748641d7f30c06fcf0/skills/frontier-simplify/SKILL.md)
