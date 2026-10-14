// The daily job: what changed since the last snapshot.
//
// A CAMIS that appears is a business that just applied: a new door for tomorrow's route. A CAMIS that disappears left
// the pre inspection list, either because its first inspection happened (it is opening now, call it today) or because
// the application lapsed. The dataset cannot tell those two apart, so the output says both.
import type { RawRow, Snapshot } from "./types.ts";

export interface SnapshotDiff {
  from: string;
  to: string;
  added: RawRow[];
  left: RawRow[];
  unchanged: number;
}

export function diffSnapshots(prev: Snapshot, curr: Snapshot): SnapshotDiff {
  const before = new Map(prev.rows.map((r) => [r.camis, r]));
  const after = new Map(curr.rows.map((r) => [r.camis, r]));
  const added = [...after.values()].filter((r) => !before.has(r.camis));
  const left = [...before.values()].filter((r) => !after.has(r.camis));
  return { from: prev.fetchedAt, to: curr.fetchedAt, added, left, unchanged: after.size - added.length };
}
