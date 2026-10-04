export interface MemoryEntryLike {
  ref: string;
}

export function findNearbyEntries<T extends MemoryEntryLike>(
  entries: T[],
  relFile: string,
  lineNum: number,
  windowSize = 5,
): T[] {
  return entries.filter((entry) => {
    const m = entry.ref.match(/^\[(.+?):(\d+)/);
    if (!m) return false;
    const refFile = m[1]!;
    const refLine = parseInt(m[2]!, 10);
    return refFile === relFile && Math.abs(refLine - lineNum) <= windowSize;
  });
}
