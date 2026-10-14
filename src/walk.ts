// Ground truth: a person walks one route and records what is actually at each door.
//
// The list is only worth a rep's day if most doors are still a live prospect. The engine cannot know that from the
// data, so one route gets checked by hand and the hit rate is reported with a 95% Wilson interval, which stays honest
// at small n. Until the walk is done the README and the card say "pending", never a guessed number.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Route } from "./types.ts";
import { csvRow } from "./export.ts";

export const WALK_STATUSES = {
  pre_open: "build out, paper on the windows, or a coming soon sign: the best door",
  just_opened: "open, and staff say it opened in the last few months: still a prospect",
  open_old: "open and clearly established: the data lagged, not a prospect",
  closed: "vacant, shuttered, or a different business: dead lead",
  not_found: "address not found or no storefront: dead lead",
} as const;
export type WalkStatus = keyof typeof WALK_STATUSES;
const HITS: WalkStatus[] = ["pre_open", "just_opened"];

export const WALK_HEADER = ["order", "camis", "name", "address", "peers_inspected", "status", "checked_by", "note"];

export function walkTemplate(route: Route): string {
  const lines = [csvRow(WALK_HEADER)];
  for (const s of route.stops) lines.push(csvRow([s.order, s.camis, s.name, s.address, s.peerMonth, "", "", ""]));
  return lines.join("\r\n") + "\r\n";
}

/** Pick the route to check by hand: the best ranked Brooklyn day (routes arrive ranked best first). */
export function pickWalkRoute(routes: Route[], boro = "Brooklyn"): Route | null {
  return routes.find((r) => r.boro === boro) ?? null;
}

export function writeTemplate(file: string, route: Route): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, walkTemplate(route));
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. A quote opens a quoted field only at its start. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = "", q = false, quoted = false;
  const endField = () => { row.push(f); f = ""; quoted = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"' && f === "" && !quoted) { q = true; quoted = true; }
    else if (c === ",") endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endField();
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else f += c;
  }
  endField();
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n, z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface WalkResult {
  status: "pending" | "partial" | "done" | "stale";
  planned: number;
  checked: number;
  hits: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  counts: Record<WalkStatus, number>;
  invalid: string[];
  offRoute: number;              // filled rows for doors that are not on the route being reported
}

/**
 * Hit rate for one route. Only rows whose CAMIS is on that route count, so a walk done on an older route is never
 * reported under a new route's name: it shows up as stale instead.
 */
export function readWalk(file: string, routeCamis: string[]): WalkResult {
  const planned = routeCamis.length, onRoute = new Set(routeCamis);
  const counts = Object.fromEntries(Object.keys(WALK_STATUSES).map((k) => [k, 0])) as Record<WalkStatus, number>;
  const empty: WalkResult = { status: "pending", planned, checked: 0, hits: 0, rate: null, ci95: null, counts, invalid: [], offRoute: 0 };
  if (!existsSync(file)) return empty;
  const [head, ...rows] = parseCsv(readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (!head) return empty;
  const col = head.indexOf("status"), idCol = head.indexOf("camis");
  if (col < 0 || idCol < 0) return { ...empty, invalid: ["walk.csv needs camis and status columns"] };
  const invalid: string[] = [];
  let offRoute = 0;
  // One verdict per door: a recheck row for the same CAMIS replaces the earlier one instead of counting twice.
  const verdict = new Map<string, WalkStatus>();
  for (const r of rows) {
    const st = (r[col] ?? "").trim().toLowerCase();
    if (!st) continue;
    const id = (r[idCol] ?? "").trim();
    if (!onRoute.has(id)) { offRoute++; continue; }
    if (!(st in WALK_STATUSES)) { invalid.push(`${id}: "${st}"`); continue; }
    verdict.set(id, st as WalkStatus);
  }
  for (const st of verdict.values()) counts[st]++;
  const checked = verdict.size;
  const hits = HITS.reduce((a, k) => a + counts[k], 0);
  return {
    status: checked === 0 ? (offRoute ? "stale" : "pending") : routeCamis.every((c) => verdict.has(c)) ? "done" : "partial",
    planned, checked, hits,
    rate: checked ? hits / checked : null,
    ci95: checked ? wilson(hits, checked) : null,
    counts, invalid, offRoute,
  };
}
