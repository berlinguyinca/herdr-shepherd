/** At most `limit` calls per `windowMs` for each key (for example one signed-in user). */
export function createActorLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hitsByKey = new Map<string, number[]>();
  return (key: string): boolean => {
    const cutoff = now() - windowMs;
    const hits = (hitsByKey.get(key) ?? []).filter((at) => at > cutoff);
    if (hits.length >= limit) {
      hitsByKey.set(key, hits);
      return false;
    }
    hits.push(now());
    hitsByKey.set(key, hits);
    // Drop idle keys so the map cannot grow without bound.
    if (hitsByKey.size > 10_000) {
      for (const [other, list] of hitsByKey) {
        if (list.every((at) => at <= cutoff)) hitsByKey.delete(other);
      }
    }
    return true;
  };
}
