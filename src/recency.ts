// Place each uninspected business against its permit number peers.
//
// The dataset gives no application date for businesses that have not been inspected. But CAMIS numbers are issued
// roughly in order: for permits issued in recent years, the rank correlation between CAMIS and first inspection date
// is about 0.83 (Spearman; computed by rankCorrelation below on every run), and the monthly median CAMIS climbs
// steadily. So for each month we know which permit numbers were getting their first inspection, and we can say where
// an uninspected business stands: its peers are being inspected now (on track), were inspected months ago (behind), or
// over a year ago (an old application: not new, though some still open late). This is an estimate and is labeled as
// one everywhere it shows up.
import type { Freshness } from "./types.ts";

/** Spearman rank correlation between CAMIS and first inspection date, over permits at or above minCamis. */
export function rankCorrelation(first: { camis: number; first: number }[], minCamis = 50100000): { rho: number; n: number } {
  const xs = first.filter((r) => r.camis >= minCamis);
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const a = rank(xs.map((r) => r.camis)), b = rank(xs.map((r) => r.first));
  const n = xs.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return { rho: n ? num / Math.sqrt(da * db) : 0, n };
}

export interface RecencyModel {
  /** month -> median CAMIS of businesses first inspected that month (running max), ascending by month */
  table: { month: string; median: number }[];
  maxInspected: number;
  asOf: string; // YYYY-MM of the snapshot
  estimate(camis: number): { month: string; freshness: Freshness; newest: boolean };
}

export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

export function buildRecency(first: { camis: number; first: number }[], asOf: string, since = "2023-01"): RecencyModel {
  const byMonth = new Map<string, number[]>();
  let maxInspected = 0;
  for (const r of first) {
    if (r.camis > maxInspected) maxInspected = r.camis;
    const m = new Date(r.first).toISOString().slice(0, 7);
    if (m < since) continue;
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r.camis);
  }
  // Monotone envelope: a later month's median can dip below an earlier one (catch up inspections of old
  // registrations), so we keep a running maximum, which makes the CAMIS to month mapping well defined.
  const table: { month: string; median: number }[] = [];
  let runMax = 0;
  for (const m of [...byMonth.keys()].sort()) {
    const v = byMonth.get(m)!.sort((x, y) => x - y);
    if (v.length < 30) continue; // too few to trust a median
    runMax = Math.max(runMax, v[Math.floor(v.length / 2)]);
    table.push({ month: m, median: runMax });
  }

  return {
    table,
    maxInspected,
    asOf,
    estimate(camis: number) {
      let month = asOf;
      if (table.length && camis < table[0].median) {
        month = `before ${table[0].month}`;
      } else if (table.length && camis <= table[table.length - 1].median) {
        for (const row of table) if (camis >= row.median) month = row.month;
      }
      // Above the latest month's median: its peers are the ones being inspected right now, or later.
      const behind = month.startsWith("before") ? 99 : monthsBetween(month, asOf);
      const freshness: Freshness = behind <= 3 ? "on_track" : behind <= 12 ? "behind" : "stalled";
      return { month, freshness, newest: camis > maxInspected };
    },
  };
}
