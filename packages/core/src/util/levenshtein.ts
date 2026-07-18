/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * The closest candidate to `target` within `maxDistance`, or `undefined`.
 * Used to suggest a "did you mean…" quick fix for an unknown reference.
 */
export function closest(target: string, candidates: Iterable<string>, maxDistance = 3): string | undefined {
  let best: string | undefined;
  let bestDist = maxDistance + 1;
  for (const candidate of candidates) {
    if (candidate === target) return candidate;
    const d = levenshtein(target, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return bestDist <= maxDistance ? best : undefined;
}
