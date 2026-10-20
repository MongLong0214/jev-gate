import type { FeatureId } from './operations.js';

export type Host = 'claude' | 'codex';
export interface HostCapability {
  mode: 'active' | 'observe' | 'connect' | 'unsupported';
  ko: string;
  en: string;
}

/** Availability is distinct from recorded use. Native permissions remain authoritative. */
export const CODEX_CAPABILITIES: Record<FeatureId, HostCapability> = {
  admission: { mode: 'active', ko: '실제 문맥 사용량과 사용자 요청으로 직접 실행과 위임을 결정합니다.', en: 'Uses observed context usage and the user request to choose direct execution or delegation.' },
  allocation: { mode: 'active', ko: '같은 Gate B 정책으로 전용 워커의 모델을 배정하고 실행 입력에 반영합니다.', en: 'Applies the shared Gate B policy to owned worker models and execution inputs.' },
  planning: { mode: 'active', ko: '읽기 전용 플래너가 계획을 만들고 코드가 의존성과 다음 작업의 실행 조건을 관리합니다.', en: 'A read-only planner returns the plan; code manages dependencies and readiness.' },
  workers: { mode: 'active', ko: '실제 Codex 워커를 실행하고 관측된 검사 결과와 계약을 대조해 수락합니다.', en: 'Runs native Codex workers and verifies observed checks against their contracts.' },
  guard: { mode: 'active', ko: '위임 중 루트 도구를 허용 목록으로 제한합니다. Codex 권한을 승인하거나 확장하지 않습니다.', en: 'Restricts root tools during delegation using the shared allowlist. Never grants or expands native permissions.' },
  router: { mode: 'active', ko: '계정의 실제 모델·effort 목록과 Jev 확률로 턴 설정을 선택합니다. 전송한 설정과 응답이 확인한 모델·effort를 구분합니다.', en: 'Selects turn settings using the live account catalog and Jev probabilities. Submitted settings and response-confirmed model or effort are distinct.' },
  compact: { mode: 'unsupported', ko: 'Codex에서는 Jev Compact를 쓰지 않습니다. Codex 자체 압축이 그대로 동작합니다.', en: 'Jev Compact does not run on Codex. Native Codex compaction runs unchanged.' },
};
export const CODEX_PLUGIN_CAPABILITIES: Record<FeatureId, HostCapability> = Object.fromEntries(Object.entries(CODEX_CAPABILITIES).map(([id, capability]) => [id,
  id === 'compact' ? capability : id === 'workers'
    ? { mode: 'observe', ko: '호스트 이벤트를 관측합니다. 자동 연결 후 새 네이티브 세션의 실제 정책 적용 기록을 기다립니다.', en: 'Observes host events. After automatic connection, a fresh native session records actual policy application.' }
    : { mode: 'connect', ko: '플러그인이 일반 Codex를 자동 연결합니다. 실제 정책 요청 기록이 들어오면 적용 상태를 표시합니다.', en: 'The plugin connects ordinary Codex automatically. Actual policy request records establish application.' },
])) as Record<FeatureId, HostCapability>;
