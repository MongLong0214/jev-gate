import type { DelegationPrices } from './admission.js';
import { providerPrice } from './provider-prices.js';

/** Local adapter observations only. Missing rereads/output/horizon cannot become a forecast. */
export const observedDelegationPrices = (host: 'claude' | 'codex', rootModel: string | null, workerModel: string, depth: number,
  startup: { range: readonly [number, number]; writeRate: number } | null = null): DelegationPrices | undefined => {
  const root = rootModel ? providerPrice(host, rootModel, depth) : null;
  const worker = startup ? providerPrice(host, workerModel, startup.range[1]) : null;
  if (!root || !worker) return undefined;
  return { root, worker, workerWriteRate: startup!.writeRate, startupRange: startup!.range,
    reexploreRange: null, outputRange: null, residualContext: 0, horizon: null, overheadUsd: null,
    provenance: 'observed_worker_start; configured_worker_candidate; rereads_output_horizon_unknown' };
};
