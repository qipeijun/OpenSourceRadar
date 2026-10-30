import type { Observation } from '../shared/contracts.js';

/** 只计算同来源累计 Star 差值；缺测保留时间跨度，不折算成日榜增量。 */
export function cumulativeChange(previous: Observation, current: Observation) {
  const elapsedMs = Date.parse(current.observedAt) - Date.parse(previous.observedAt);
  if (previous.projectId !== current.projectId || previous.sourceUrl !== current.sourceUrl || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return { starsChange: current.stars - previous.stars, elapsedHours: elapsedMs / 3_600_000, hasGap: elapsedMs > 36 * 3_600_000 };
}
