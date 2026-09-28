/** The public contract of `jev_evidence` (ADR #74 D3). Lines are 1-based and inclusive; hashes are of whole-file bytes. */
export interface SourceRef {
  path: string;
  startLine: number;
  endLine: number;
  fileSha256: string;
}

export const MODES = ['locate', 'audit'] as const;
export type EvidenceMode = (typeof MODES)[number];

export interface EvidenceRequest {
  goal: string;
  roots?: string[];
  mode?: EvidenceMode;
  queryTerms?: string[];
  exactSymbols?: string[];
  constraints?: string[];
  limit?: number;
  offset?: number;
  expectedSnapshot?: string;
  sources?: SourceRef[];
}

export const JUDGEMENTS = ['relevant', 'unrelated', 'needs_context'] as const;
export type Judgement = (typeof JUDGEMENTS)[number];

export type TextState = 'included' | 'omitted_irrelevant' | 'omitted_budget' | 'stale';

export interface EvidenceItem {
  source: SourceRef;
  text?: string;
  textState: TextState;
  origin: 'local' | 'jev';
  judgement: Judgement | 'unjudged';
  probabilities?: Record<Judgement, number>;
}

export interface Coverage {
  inventoryComplete: boolean;
  filesTotal: number | null;
  readFiles: number;
  skippedFiles: number;
  candidates: number;
  pageCandidates: number;
  unjudgedOnPage: number;
  omittedBodies: number;
  sourceIncomplete: boolean;
}

/** Closed: a new situation gets its own code here, never a provider's free text. */
export const REASON_CODES = [
  'invalid_input',
  'unavailable_config',
  'out_of_scope',
  'unsupported_inventory',
  'no_candidate',
  'source_limit',
  'line_too_long',
  'deadline',
  'output_limit',
  'range_too_large',
  'source_changed',
  'source_missing',
  'source_unverified',
  'missing_key',
  'remote_disabled',
  'remote_secret',
  'remote_budget',
  'remote_failed',
  'remote_timeout',
  'busy',
  'cancelled',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface EvidenceResult {
  version: 1;
  projectRoot: string | null;
  status: 'ok' | 'partial' | 'unavailable' | 'cancelled';
  backend: 'local' | 'jev' | 'mixed';
  items: EvidenceItem[];
  snapshotId: string | null;
  next: { offset: number; expectedSnapshot: string } | null;
  coverage: Coverage;
  reasonCodes: ReasonCode[];
}

/** What the owner fixes at start: the only roots the reader may touch, and whether any source may leave the machine. */
export interface EvidenceConfig {
  projectRoot: string;
  allowedRoots: string[];
  excludeGlobs: string[];
  remote: boolean;
}

/**
 * Every bound in one place (ADR D7). Initial policy values chosen for ordinary requests, not measured optima; the
 * token figure is the estimate `src/lean.ts` calibrated, not a provider count.
 */
export const LIMITS = {
  inputBytes: 16 * 1024,
  arrayItems: 16,
  inventoryBytes: 2 * 1024 * 1024,
  files: 200,
  fileBytes: 256 * 1024,
  totalReadBytes: 16 * 1024 * 1024,
  /** Held back from the search so every file a page can return is read again before it is published. */
  verifyReserveBytes: 16 * 256 * 1024,
  candidates: 1024,
  windowLines: 40,
  windowBytes: 8 * 1024,
  defaultPage: 8,
  maxPage: 16,
  batch: 8,
  httpPerCall: 2,
  concurrentCalls: 2,
  concurrentHttp: 4,
  deadlineMs: 3000,
  remoteMs: 1500,
  /** Kept for publishing (re-hashing and assembling) after the search and any remote judgement. */
  publishReserveMs: 400,
  requestBytes: 128 * 1024,
  requestTokens: 25_000,
  resultBytes: 64 * 1024,
  configBytes: 64 * 1024,
  cacheEntries: 128,
  cacheBytes: 2 * 1024 * 1024,
  cacheTtlMs: 10 * 60 * 1000,
} as const;

/** Initial policy values (ADR D5), not accuracies: at or above them a page item is ordered first, or folded. */
export const RELEVANT_FLOOR = 0.8;
export const UNRELATED_FLOOR = 0.9;

export const EVIDENCE_MODEL = 'jev-1.13.0';
