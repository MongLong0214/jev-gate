# jev-gate 구현 지침

먼저 README와 GitHub 이슈 [#1](https://github.com/MongLong0214/jev-gate/issues/1), [#2](https://github.com/MongLong0214/jev-gate/issues/2)를 읽고 [#3](https://github.com/MongLong0214/jev-gate/issues/3)부터 구현한다. 개발 순서는 #3 → #4 → #5 → #6 → #7이다.

- 현재 branch와 사용자 변경을 확인하고 보존한다. 기존 구현이 있다면 정상 코드를 재사용한다.
- 명세는 이슈가 소유한다. 추가 PRD 사본, 시작 승인 JSON, 문서 validator, review ledger를 만들지 않는다.
- MVP는 자체완결 텍스트 요청의 worker/frontier 라우팅 하나다. TypeScript CLI, native HTTP, 세 모드 비교만 만든다.
- 첫 납품은 fake HTTP로 plan → run → 세 모드 bench → report가 연결되는 코드다. 실제 키가 없다고 offline 개발을 멈추지 않는다.
- Jev는 TypeSafe Bearer key와 `/v1/systemone`을 사용한다. worker/frontier는 별도의 생성 API 설정과 키를 사용한다. 키 값은 출력·이슈·Git·모델 state에 넣지 않는다.
- 기본 plan과 report는 HTTP 호출이 없다. tests/CI/install에서 유료 API를 호출하지 않는다. live는 명시적으로 허가된 데이터·계정·유한 범위에서만 실행한다.
- retry/cascade/context pruning/생성 코드 실행/서버/DB는 추가하지 않는다. 사용자 abort나 local write 오류 후 새 모델 호출을 하지 않는다.
- 실패·미시작·unknown 비용은 보존한다. worker-only가 더 낫다는 결과도 숨기지 않는다. confidence를 정답률로 해석하지 않는다.
- 실제 함수 동작과 회귀를 검사한다. 이슈 개수, 문서 문구, 승인 상태를 검사하는 테스트는 만들지 않는다.
- 패키지 구현 후 `npm run typecheck`, `npm test`, `npm run build`를 실제 실행한다. 아직 package가 없는 상태에서 성공했다고 보고하지 않는다.
- 최종 보고에서 구현 완료, fake 테스트, 설치 환경 live 확인, 실제 비용·속도 개선 관측을 구분한다. 요청 없이 release/npm publish/대외 홍보는 하지 않는다.

`frontier-simplify` 참고: https://github.com/MongLong0214/frontier-simplify/blob/96b07ad17e90fd4e69e1a7748641d7f30c06fcf0/skills/frontier-simplify/SKILL.md . 원리를 적용하되 그 스킬의 별도 실행·검증 framework를 이식하지 않는다.
