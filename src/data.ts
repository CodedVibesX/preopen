// Fetch and load NYC Open Data. Every run reads committed files, so the numbers in the README reproduce offline;
// `npm run fetch` adds a new snapshot of the uninspected list and refreshes the reference file of inspected places.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawRow, Snapshot } from "./types.ts";

export const DATASET = "https://data.cityofnewyork.us/resource/43nn-pn8j.json";
export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const SNAP_DIR = join(DATA_DIR, "snapshots");
const REF_FILE = join(DATA_DIR, "inspected_places.json");

/** The official marker: "Establishments with inspection date of 1/1/1900 are new establishments that have not yet received an inspection." */
export const PRE_INSPECTION = "1900-01-01T00:00:00.000";

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`NYC Open Data answered HTTP ${res.status} for ${url}`);
  return res.json();
}

const stamp = (iso: string) => `${iso.replace(/[-:.]/g, "").slice(0, 15)}Z`;

const latestRecord = (rows: RawRow[]) => rows.reduce((m, r) => (r.record_date && r.record_date > m ? r.record_date : m), "");

/** Saves today's uninspected list, unless the city has not published since the last snapshot (then returns null). */
export async function fetchSnapshot(): Promise<string | null> {
  const url = new URL(DATASET);
  url.searchParams.set("$where", `inspection_date='${PRE_INSPECTION}'`);
  url.searchParams.set("$limit", "50000");
  const rows = (await getJson(url)) as RawRow[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("NYC Open Data returned no pre inspection rows; refusing to write an empty snapshot");
  const last = listSnapshots().at(-1);
  if (last && latestRecord(loadSnapshot(last).rows) === latestRecord(rows)) return null;
  const snap: Snapshot = { fetchedAt: new Date().toISOString(), source: url.toString(), rows };
  mkdirSync(SNAP_DIR, { recursive: true });
  const file = join(SNAP_DIR, `${stamp(snap.fetchedAt)}.json`);
  writeFileSync(file, JSON.stringify(snap));
  return file;
}

/** One inspected establishment, as the reference file stores it. Dates are YYYY-MM-DD. */
export interface InspectedPlace {
  camis: string; dba: string; building: string; street: string; zip: string; phone: string; bin: string;
  first: string; last: string;
  permitType: string | null;     // its first pre permit initial inspection: "operational" or "non_operational"
}

const REF_COLUMNS = ["camis", "dba", "building", "street", "zip", "phone", "bin", "first", "last", "permitType"] as const;

/**
 * The inspected half of the same dataset: every place the city has inspected, with name, address, phone, building ID
 * and first and last inspection. It tells an established place with a fresh permit from a new place, a franchise operator's phone from an owner's,
 * a hotel or office building from a storefront, and it calibrates the recency model.
 */
export async function fetchReference(): Promise<string> {
  const places = new URL(DATASET);
  places.searchParams.set("$select", "camis,dba,building,street,zipcode,phone,bin,min(inspection_date) as first,max(inspection_date) as last");
  places.searchParams.set("$where", "inspection_date > '1901-01-01'");
  places.searchParams.set("$group", "camis,dba,building,street,zipcode,phone,bin");
  places.searchParams.set("$order", "camis");
  places.searchParams.set("$limit", "200000");
  const rows = (await getJson(places)) as Record<string, string>[];
  if (!Array.isArray(rows) || rows.length < 1000) throw new Error(`reference pull returned ${Array.isArray(rows) ? rows.length : "no"} rows; refusing to overwrite`);

  // Whether each place was already serving at its first permit inspection.
  const permits = new URL(DATASET);
  permits.searchParams.set("$select", "camis,inspection_type,min(inspection_date) as d");
  permits.searchParams.set("$where", "inspection_type like 'Pre-permit%Initial Inspection'");
  permits.searchParams.set("$group", "camis,inspection_type");
  permits.searchParams.set("$limit", "200000");
  const firstPermit = new Map<string, { type: string; d: string }>();
  for (const r of (await getJson(permits)) as Record<string, string>[]) {
    const type = /Non-operational/i.test(r.inspection_type) ? "non_operational" : "operational";
    const prev = firstPermit.get(r.camis);
    if (!prev || r.d < prev.d) firstPermit.set(r.camis, { type, d: r.d });
  }

  const day = (s: string | undefined) => String(s ?? "").slice(0, 10);
  const ref = {
    fetchedAt: new Date().toISOString(),
    source: [places.toString(), permits.toString()],
    columns: REF_COLUMNS,
    rows: rows.map((r) => [r.camis, r.dba, r.building, r.street, r.zipcode, r.phone, r.bin, day(r.first), day(r.last), firstPermit.get(r.camis)?.type ?? ""]
      .map((v) => String(v ?? "").replace(/\s+/g, " ").trim())),
  };
  writeFileSync(REF_FILE, JSON.stringify(ref));
  return REF_FILE;
}

let refCache: { fetchedAt: string; places: InspectedPlace[] } | null = null;
export function loadInspected(): { fetchedAt: string; places: InspectedPlace[] } {
  if (refCache) return refCache;
  const j = JSON.parse(readFileSync(REF_FILE, "utf8")) as { fetchedAt: string; columns: string[]; rows: string[][] };
  const at = (name: string) => j.columns.indexOf(name);
  const idx = Object.fromEntries(REF_COLUMNS.map((c) => [c, at(c)])) as Record<(typeof REF_COLUMNS)[number], number>;
  refCache = {
    fetchedAt: j.fetchedAt,
    places: j.rows.map((r) => ({
      camis: r[idx.camis], dba: r[idx.dba], building: r[idx.building], street: r[idx.street], zip: r[idx.zip],
      phone: r[idx.phone], bin: r[idx.bin], first: r[idx.first], last: r[idx.last], permitType: r[idx.permitType] || null,
    })),
  };
  return refCache;
}

export function listSnapshots(): string[] {
  if (!existsSync(SNAP_DIR)) return [];
  return readdirSync(SNAP_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => join(SNAP_DIR, f));
}

export function loadSnapshot(file?: string): Snapshot {
  const f = file ?? listSnapshots().at(-1);
  if (!f) throw new Error("no snapshot yet; run `npm run fetch` first");
  return JSON.parse(readFileSync(f, "utf8")) as Snapshot;
}

/** Names with 5 or more active inspected NYC locations, counted by normalized name. The dataset holds active places only. */
export function loadChains(): Map<string, number> {
  const byName = new Map<string, Set<string>>();
  for (const p of loadInspected().places) {
    const k = normName(p.dba);
    if (k) (byName.get(k) ?? byName.set(k, new Set()).get(k)!).add(p.camis);
  }
  return new Map([...byName].filter(([, s]) => s.size >= 5).map(([k, s]) => [k, s.size]));
}

/**
 * CAMIS of every inspected establishment with its first inspection date. The city's dates carry no zone; they are read
 * as UTC so the result is the same on every machine.
 */
export function loadFirstInspections(): { camis: number; first: number }[] {
  const first = new Map<string, string>();
  for (const p of loadInspected().places) if (p.first && (!first.has(p.camis) || p.first < first.get(p.camis)!)) first.set(p.camis, p.first);
  return [...first].map(([c, d]) => ({ camis: Number(c), first: Date.parse(`${d}T00:00:00Z`) })).filter((r) => r.camis && r.first);
}

/**
 * Where each CAMIS that left the uninspected list went: its first real inspection (date and whether the place was
 * already operating) or nothing, which means the application lapsed or was withdrawn. Network; used by `npm run diff`.
 */
export async function lookupFirstInspections(camis: string[]): Promise<Map<string, { date: string; type: string }>> {
  const out = new Map<string, { date: string; type: string }>();
  for (let i = 0; i < camis.length; i += 150) {
    const url = new URL(DATASET);
    url.searchParams.set("$select", "camis,inspection_type,min(inspection_date) as d");
    url.searchParams.set("$where", `inspection_date > '1901-01-01' AND camis in (${camis.slice(i, i + 150).map((c) => `'${c.replace(/\D/g, "")}'`).join(",")})`);
    url.searchParams.set("$group", "camis,inspection_type");
    url.searchParams.set("$limit", "5000");
    // On the first date, the pre permit initial inspection is the one that says whether the place was operating.
    const rank = (t: string) => (/Pre-permit.*Initial/i.test(t) ? 0 : 1);
    for (const r of (await getJson(url)) as Record<string, string>[]) {
      const prev = out.get(r.camis), date = r.d.slice(0, 10), type = r.inspection_type ?? "";
      if (!prev || date < prev.date || (date === prev.date && rank(type) < rank(prev.type))) out.set(r.camis, { date, type });
    }
  }
  return out;
}

/** The New York calendar month of an instant, "2026-10": a snapshot pulled at 11 pm ET on Oct 31 belongs to October. */
export function nyMonth(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

/**
 * The names New Yorkers use for the tabulation areas the city names differently ("North Side-South Side" is
 * Williamsburg, "Clinton" is Hell's Kitchen). Display only; the NTA code stays in the data.
 */
const COMMON_NAMES: Record<string, string> = {
  BK73: "Williamsburg", MN15: "Hell's Kitchen", MN13: "Chelsea, Flatiron and Union Square", MN24: "SoHo, TriBeCa and Little Italy",
  MN17: "Midtown", MN25: "Financial District", MN19: "Midtown East", MN20: "Murray Hill and Kips Bay", MN23: "West Village",
  QN31: "Long Island City and Sunnyside", BK09: "Brooklyn Heights and Cobble Hill", BK37: "Park Slope and Gowanus", BK38: "Downtown Brooklyn and DUMBO",
};

/** Neighborhood Tabulation Area code to a readable name ("BK73" to "Williamsburg"). */
export function loadNtaNames(): Map<string, string> {
  const j = JSON.parse(readFileSync(join(DATA_DIR, "nta2010_names.json"), "utf8")) as { names: Record<string, string> };
  return new Map(Object.entries(j.names).map(([k, v]) => [k, COMMON_NAMES[k] ?? v.replace(/\s*-\s*/g, ", ")]));
}

/**
 * Uppercase, strip accents, punctuation and filler so "DUNKIN'" and "DUNKIN" match and "CAFÉ" reads as "CAFE".
 * "CO" is filler except after "AND": "FRESH & CO" is a brand, not "FRESH AND".
 */
export function normName(s: string | undefined): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/['’‘`´ʼ]/g, "") // possessives join their word: "RUDY'S" is RUDYS, not RUDY S
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(THE|INC|LLC|LTD|CORP|CORPORATION|USA|HOLDINGS|GROUP|NYC|NY)\b/g, " ")
    .replace(/(?<!\bAND )\bCO\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
