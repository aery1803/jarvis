/**
 * Jarvis Local AI Agent: Stable Recency Ordering
 * Authority: Section 8.1 (memory tiers), Section 6.2 (audit log)
 *
 * Every collection in the document store stamps its own ISO timestamp at write time, and `Collection.find()`
 * returns rows in insertion order. Two writes inside the same millisecond therefore share a timestamp, and a
 * plain `b.time - a.time` comparator leaves their relative order up to the engine's sort -- so "the most
 * recent entry" can come back second. That is not hypothetical: triggering and then resetting the kill switch
 * usually happens within one millisecond, and the audit log reported the stale event as the newest one.
 *
 * Ties are therefore broken by position in the source array, which for `find()` is insertion order: of two
 * rows written in the same millisecond, the one inserted later counts as newer.
 */

/** Sorts newest first, breaking same-timestamp ties by insertion position. Does not mutate `items`. */
export function newestFirst<T>(items: T[], timestampOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, time: new Date(timestampOf(item)).getTime() }))
    .sort((a, b) => b.time - a.time || b.index - a.index)
    .map(({ item }) => item);
}

/** `newestFirst` for the common `createdAt` field. */
export function newestByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return newestFirst(items, (item) => item.createdAt);
}
