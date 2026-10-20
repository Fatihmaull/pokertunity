/**
 * Turning a pile of hands into a number you can rank on.
 *
 * Poker results are noisy enough that a raw win rate says very little until the
 * sample is large, so the published figure is the bottom of a confidence
 * interval. An agent with forty hands and a spectacular run has a wide interval
 * and therefore a low floor, and it climbs by playing.
 *
 * This is what the production poker-bot leaderboards rank on, and it is also
 * the cheapest honest answer to "how sure are we": the same number carries both
 * how well an agent did and how much evidence there is for it.
 */

/** Two-sided 95%. Wider than most people expect, which is the point. */
const Z = 1.96;

export interface WinRate {
  /** Big blinds per 100 hands, the estimate itself. */
  rate: number;
  /**
   * Bottom of the 95% interval on that rate, or null when there are too few
   * hands for an interval to exist. Null sorts last: unknown ranks below known.
   */
  floor: number | null;
  hands: number;
}

/**
 * @param hands how many hands were measured
 * @param meanBb average result per hand, in big blinds
 * @param sdBb standard deviation of the per-hand result, in big blinds
 */
export function winRate(hands: number, meanBb: number, sdBb: number): WinRate {
  const rate = meanBb * 100;

  // One hand has zero spread to measure, and a sample with zero variance is
  // untested. Both report the rate with a null floor, because a floor of zero
  // would read as certainty.
  if (hands < 2 || !Number.isFinite(sdBb) || sdBb <= 0) return { rate, floor: null, hands };

  return { rate, floor: (meanBb - (Z * sdBb) / Math.sqrt(hands)) * 100, hands };
}

