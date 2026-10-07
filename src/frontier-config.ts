import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Env } from './config.js';
import { frontierConfigPath, parseFrontierRouting } from './frontier-routing.js';

/** Read at each policy boundary, so OFF also rejects an earlier unsubmitted frontier choice. */
export const frontierRoutingEnabled = (env: Env, legacy = false): boolean => {
  const path = frontierConfigPath(env['HOME'] || homedir(), env['XDG_CONFIG_HOME'], env['JEV_GATE_CONFIG']);
  if (!path) return legacy;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return false;
    return parseFrontierRouting(readFileSync(path, 'utf8')) ?? legacy;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? legacy : false; }
};
