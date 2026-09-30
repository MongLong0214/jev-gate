import type { FeatureId } from './operations.js';

export type Host = 'claude' | 'codex';
export interface HostCapability {
  mode: 'active' | 'observe' | 'unsupported';
  ko: string;
  en: string;
}

/** Native Codex plugin capabilities. A loaded hook is not evidence of policy enforcement. */
export const CODEX_CAPABILITIES: Record<FeatureId, HostCapability> = {
  admission: { mode: 'unsupported', ko: '자동 Gate A는 비활성입니다. Codex의 문맥 깊이와 실행 계약을 보장할 어댑터가 없습니다.', en: 'Automatic Gate A is disabled: Codex context depth and execution contracts are not supported by this adapter.' },
  allocation: { mode: 'unsupported', ko: 'Gate B 자동 배정은 비활성입니다. 입력 교체에 권한 승인이 필요한 Codex 훅을 사용하지 않습니다.', en: 'Automatic Gate B is disabled: Codex requires an allow decision for input replacement.' },
  planning: { mode: 'unsupported', ko: 'Jev 계획·의존성 관리는 비활성입니다. Codex는 Claude의 전용 에이전트 프로필을 로드하지 않습니다.', en: 'Jev plan and dependency management is disabled: Codex does not load Claude agent profiles.' },
  workers: { mode: 'observe', ko: 'Codex 도구와 에이전트의 시작·종료를 관측합니다. 생성 응답은 작업 완료나 계약 수락을 뜻하지 않습니다.', en: 'Observes Codex tools and agents starting and stopping. A spawn receipt is not completion or contract acceptance.' },
  guard: { mode: 'unsupported', ko: 'Jev 루트 가드는 비활성입니다. Codex 자체 sandbox와 승인 정책이 적용됩니다.', en: 'The Jev root guard is disabled. Codex sandbox and approval policies remain in force.' },
  lean: { mode: 'unsupported', ko: 'Lean 자동 문맥 교체는 비활성입니다. 안정적인 transcript 계약과 승인 없는 입력 교체가 필요합니다.', en: 'Automatic Lean handoff is disabled: it needs a stable transcript contract and input replacement without approval.' },
  router: { mode: 'unsupported', ko: '자동 모델·effort 변경은 비활성입니다. Codex 훅에 루트 모델·effort 변경 출력이 없습니다.', en: 'Automatic model and effort routing is disabled: Codex hooks cannot override the root model or effort.' },
  compact: { mode: 'observe', ko: 'Codex 압축 시작·종료를 관측합니다. 추출형 요약으로 압축 결과를 교체하지 않습니다.', en: 'Observes native Codex compaction. Does not replace its result with an extractive digest.' },
  output: { mode: 'active', ko: '완전한 성공 Vitest 출력에서 동일한 연속 줄만 접습니다. 실패·잘림·알 수 없는 형식은 보존합니다.', en: 'Folds identical consecutive lines in complete passing Vitest output. Preserves failures, truncation and unknown formats.' },
  evidence: { mode: 'active', ko: '동일한 Evidence MCP를 사용합니다. 로컬 검색과 Jev 판정, 페이지·캐시·근거 읽기를 지원합니다.', en: 'Uses the same Evidence MCP: local search, Jev judgments, pagination, cache and evidence reads.' },
};
