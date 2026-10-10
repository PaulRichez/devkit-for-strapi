/**
 * Settle with `fallback` if `p` hasn't settled within `ms` — a last-resort guard
 * so a pathological input can never wedge the engine (the static plugin reader
 * has its own budgets; this bounds anything they might miss).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), t]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
