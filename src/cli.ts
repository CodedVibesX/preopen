// preopen: NYC food businesses so new the Health Department has not inspected them yet, turned into walkable door to
// door routes and a HubSpot import.
//
//   npm run fetch   pull today's uninspected list and refresh the inspected places reference from NYC Open Data
//   npm start       score, route and export from the latest snapshot (offline, reproducible)
//   npm run diff    new doors and departures between the last two snapshots
//   npm run walk    hit rate from the hand checked route (validation/walk.csv)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchReference, fetchSnapshot, listSnapshots, loadFirstInspections, loadInspected, loadNtaNames, loadSnapshot, lookupFirstInspections, nyMonth } from "./data.ts";
import { addressKey, addressWords, buildChains, isParkConcession, isSeasonal, normPhone, realBin, sameBusiness, titleCase, toProspects } from "./clean.ts";
import { buildRecency, rankCorrelation } from "./recency.ts";
import { scoreAll } from "./score.ts";
import { buildRoutes } from "./route.ts";
import { csvRow, hubspotCsv, safeText, skippedCsv, writeOutputs } from "./export.ts";
import { pickWalkRoute, readWalk, writeTemplate, WALK_STATUSES } from "./walk.ts";
import { diffSnapshots } from "./diff.ts";
import type { RawRow, Route, Scored, Snapshot } from "./types.ts";
import type { InspectedPlace } from "./data.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = join(ROOT, "leads");
const CARD = join(ROOT, "app", "card.json");
const VALID = join(ROOT, "validation");
const DOCS = join(ROOT, "docs");

/** "Oct 13, 2026, 11:53 PM" in New York time, for console output. */
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
const stamp = (iso: string) => nyMonth(iso).replace("-", "") + new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", day: "2-digit" });
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const tally = <T,>(xs: T[], key: (x: T) => string) => { const m: Record<string, number> = {}; for (const x of xs) { const k = key(x); m[k] = (m[k] ?? 0) + 1; } return m; };

export function pipeline(snap: Snapshot) {
  const asOf = nyMonth(snap.fetchedAt);
  const inspected = loadInspected().places;
  const recency = buildRecency(loadFirstInspections(), asOf);
  const chains = buildChains(inspected, snap.rows);
  const scored = scoreAll(toProspects(snap.rows, chains, recency, loadNtaNames(), inspected));
  const qualified = scored.filter((s) => s.qualified);
  const { routes, unrouted } = buildRoutes(qualified);
  return { asOf, recency, scored, qualified, routes, unrouted };
}

function hoodTable(qualified: Scored[], routes: Route[]) {
  const rows = new Map<string, { hood: string; boro: string; qualified: number; onTrack: number; routed: number }>();
  for (const s of qualified) {
    const k = s.nta ?? "none";
    const r = rows.get(k) ?? { hood: s.hood ?? "No neighborhood code", boro: s.boro, qualified: 0, onTrack: 0, routed: 0 };
    r.qualified++;
    if (s.freshness === "on_track") r.onTrack++;
    rows.set(k, r);
  }
  for (const rt of routes) for (const s of rt.stops) rows.get(s.nta ?? "none")!.routed++;
  return [...rows.entries()].filter(([k]) => k !== "none")
    .map(([nta, r]) => ({ nta, ...r }))
    .sort((a, b) => b.qualified - a.qualified || b.onTrack - a.onTrack);
}

/** Sites: markets, food halls, concessions and caterer lines. One operator call each instead of a walk. */
export function siteList(scored: Scored[]) {
  const by = new Map<string, Scored[]>();
  for (const s of scored) if (s.siteKind && s.siteKey) (by.get(s.siteKey) ?? by.set(s.siteKey, []).get(s.siteKey)!).push(s);
  return [...by.values()].map((g) => {
    const kind = g[0].siteKind!;
    const addresses = new Set(g.map((s) => s.address)).size;
    const where = kind === "phone" ? `one phone line (${g[0].phone?.slice(2, 5) ?? "?"} area code), ${addresses} addresses` : `${g[0].address}, ${g[0].boro}`;
    return { kind, where, boro: g[0].boro, hood: g[0].hood ?? "", filings: g[0].siteSize, businesses: g.length,
      phone: kind === "phone" ? g[0].phone : null, names: g.map((s) => s.name) };
  }).sort((a, b) => b.filings - a.filings);
}

/** The engine's own evidence for its two headline estimates, recomputed on every run from the reference file. */
function evidence(snap: Snapshot) {
  const corr = rankCorrelation(loadFirstInspections());
  const year = nyMonth(snap.fetchedAt).slice(0, 4);
  const firstSeen = new Map<string, { first: string; type: string | null }>();
  for (const q of loadInspected().places) {
    const prev = firstSeen.get(q.camis);
    if (!prev || q.first < prev.first) firstSeen.set(q.camis, { first: q.first, type: q.permitType ?? prev?.type ?? null });
    else if (!prev.type && q.permitType) prev.type = q.permitType;
  }
  let operational = 0, notYet = 0;
  for (const v of firstSeen.values()) if (v.first.startsWith(year) && v.type) v.type === "operational" ? operational++ : notYet++;
  return { rho: Math.round(corr.rho * 100) / 100, rhoN: corr.n, year, operational, notYet };
}

export function summarize(snap: Snapshot, p: ReturnType<typeof pipeline>) {
  const { scored, qualified, routes, unrouted, recency } = p;
  const isNew = scored.filter((s) => !s.repermit);
  const independent = isNew.filter((s) => !s.chain && !s.franchise);
  const owner = independent.filter((s) => s.bizType !== "institutional" && !s.building && !isParkConcession(s.address, s.zip));
  const doors = owner.filter((s) => !s.siteKind && !isSeasonal(s.rawName, s.address));
  const placed = doors.filter((s) => s.lat !== null && s.boro !== "Unknown");
  const sites = siteList(scored);
  const routedDoors = routes.reduce((a, r) => a + r.stops.length, 0);
  const walkRoute = pickWalkRoute(routes);
  const scores = qualified.map((s) => s.score);
  return {
    snapshot: { fetchedAt: snap.fetchedAt, source: snap.source, rows: snap.rows.length },
    funnel: [
      { step: "applied for a permit, not yet inspected", n: new Set(snap.rows.map((r) => r.camis)).size },
      { step: "one per business (duplicate filings merged)", n: scored.length },
      { step: "new (not an established place with a fresh permit)", n: isNew.length },
      { step: "independent (not a chain with 5+ NYC locations or a franchise operator's unit)", n: independent.length },
      { step: "an owner who buys (not a school, hospital, hotel, office, venue or park kitchen)", n: owner.length },
      { step: "a storefront door (not a market, food hall, concession, caterer line or holiday kiosk)", n: doors.length },
      { step: "placed on the map", n: placed.length },
      { step: "not an old application (permit number peers inspected within 12 months, est.)", n: qualified.length },
      { step: "on a walkable route", n: routedDoors },
    ],
    repermits: scored.filter((s) => s.repermit).length,
    established: {
      fresh: scored.filter((s) => s.repermit && !s.repermit.newer && !s.repermit.byPhone).length,
      alreadyOpen: scored.filter((s) => s.repermit?.newer).length,
      sameLine: scored.filter((s) => s.repermit?.byPhone && !s.repermit.newer).length,
    },
    // Only the units the chain rule alone would have missed: a chain named store is a chain whoever runs it.
    franchiseUnits: scored.filter((s) => s.franchise && !s.repermit && !s.chain).length,
    ownerGroups: new Set(qualified.filter((s) => s.owner).map((s) => s.owner)).size,
    qualifiedByBoro: tally(qualified, (s) => s.boro),
    qualifiedByType: tally(qualified, (s) => s.bizType),
    qualifiedByFreshness: tally(qualified, (s) => s.freshness),
    withPhone: qualified.filter((s) => s.phone).length,
    scoreRange: { min: Math.min(...scores), max: Math.max(...scores) },
    routes: {
      count: routes.length,
      doors: routedDoors,
      unrouted: unrouted.length,
      byBoro: tally(routes, (r) => r.boro),
      medianDoors: median(routes.map((r) => r.stops.length)),
      medianKm: median(routes.map((r) => r.walkKm)),
      medianHours: median(routes.map((r) => r.hours)),
      top: routes.slice(0, 8).map((r) => ({ id: r.id, boro: r.boro, hood: r.hood, doors: r.stops.length, km: r.walkKm, hours: r.hours })),
    },
    hoods: hoodTable(qualified, routes).slice(0, 12),
    sites: {
      count: sites.length,
      filings: sites.reduce((a, s) => a + s.filings, 0),
      byKind: tally(sites, (s) => s.kind),
      top: sites.slice(0, 8).map(({ names, phone: _phone, ...s }) => ({ ...s, sample: names.slice(0, 3) })),
    },
    recency: { asOf: recency.asOf, months: recency.table.length, first: recency.table[0], last: recency.table.at(-1) },
    evidence: evidence(snap),
    walk: { route: walkRoute?.id ?? null, hood: walkRoute?.hood ?? null, ...readWalk(join(VALID, "walk.csv"), walkRoute?.stops.map((s) => s.camis) ?? []) },
  };
}

/** Today's new doors, judged against the whole list: a new kiosk at a known market is still a site, a refiling is not new. */
export function newDoors(prev: Snapshot, curr: Snapshot) {
  const d = diffSnapshots(prev, curr);
  const added = new Set(d.added.map((r) => r.camis));
  const known = new Set(prev.rows.map((r) => r.camis));
  const now = pipeline(curr), before = pipeline(prev);
  const merged = (s: Scored) => s.flags.map((f) => f.match(/^duplicate filing merged: CAMIS (\d+)/)?.[1]).filter((c): c is string => !!c);
  // Yesterday's verdict for every CAMIS, including the ones merged into a kept record.
  const verdict = new Map<string, Scored>();
  for (const s of before.scored) for (const c of [s.camis, ...merged(s)]) verdict.set(c, s);
  // A refiling only hides a new filing when the place it repeats was already a door (and so already imported).
  const refiled = (s: Scored) => merged(s).some((c) => known.has(c) && verdict.get(c)?.qualified);
  const fresh = now.scored.filter((s) => added.has(s.camis));
  // A new CAMIS can also be merged INTO a place already listed; count it as a refiling too.
  const absorbed = now.scored.filter((s) => !added.has(s.camis) && merged(s).some((c) => added.has(c))).length;
  const doors = fresh.filter((s) => s.qualified && !refiled(s));
  // Departures are the CAMIS numbers that actually left, each with yesterday's verdict for the place it belonged to.
  const left = d.left.map((r) => ({ row: r, was: verdict.get(r.camis) ?? null }));
  return { d, fresh, doors, refilings: fresh.filter(refiled).length + absorbed, skipped: fresh.filter((s) => !s.qualified).length, left };
}

/**
 * Where a departed CAMIS went, from the city's records: its own first inspection; or the same business inspected
 * under another CAMIS at the same address or building (it opened under a new permit); or nothing (lapsed or withdrawn).
 */
export function departureFate(row: RawRow, own: { date: string; type: string } | undefined, inspected: InspectedPlace[]): string {
  if (own) return `first inspection ${own.date}, ${/Non-operational/i.test(own.type) ? "not yet operating" : "operating"}`;
  const key = addressKey(`${row.building ?? ""} ${row.street ?? ""}`, String(row.zipcode ?? ""));
  const bin = realBin(row.bin);
  const twin = inspected.filter((q) => q.camis !== row.camis && (addressKey(`${q.building} ${q.street}`, q.zip) === key || (!!bin && realBin(q.bin) === bin))
    && sameBusiness(String(row.dba ?? ""), q.dba, addressWords(`${row.building ?? ""} ${row.street ?? ""}`))).sort((a, b) => b.first.localeCompare(a.first))[0];
  return twin ? `opened under another permit: CAMIS ${twin.camis}, first inspected ${twin.first}` : "no inspection on record: lapsed or withdrawn";
}

async function main() {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "fetch") {
    const file = await fetchSnapshot();
    console.log(file ? `saved ${relative(ROOT, file)}` : "the city has not published since the last snapshot; nothing new to save");
    const ref = await fetchReference();
    console.log(`refreshed ${relative(ROOT, ref)} (${loadInspected().places.length} inspected places)`);
    return;
  }
  if (cmd === "run") {
    const snap = loadSnapshot(process.argv[3]);
    const t0 = Date.now();
    const p = pipeline(snap);
    const summary = summarize(snap, p);
    const walkRoute = pickWalkRoute(p.routes);
    writeOutputs(OUT, CARD, p.routes, p.unrouted, p.scored, summary, walkRoute ? [walkRoute.id] : []);
    writeFileSync(join(OUT, "sites.csv"), [csvRow(["kind", "where", "borough", "neighborhood", "filings", "phone", "names"]),
      ...siteList(p.scored).map((s) => csvRow([s.kind, s.where, s.boro, s.hood, s.filings, s.phone ?? "", s.names.join("; ")]))].join("\r\n") + "\r\n");
    // Every skipped business with its reasons: the full file in leads/, and a committed copy without phone numbers.
    writeFileSync(join(OUT, "skipped.csv"), skippedCsv(p.scored, true));
    mkdirSync(DOCS, { recursive: true });
    writeFileSync(join(DOCS, "skipped.csv"), skippedCsv(p.scored, false));
    if (walkRoute) {
      writeTemplate(join(VALID, "walk_template.csv"), walkRoute);
      // A committed sample of the import: the hand check route's rows, phone numbers masked. The real file is in leads/.
      writeFileSync(join(DOCS, "sample_hubspot_import.csv"), hubspotCsv(walkRoute.stops.map((s) => ({
        s: { ...s, phone: s.phone ? `${s.phone.slice(0, 5)}XXXXXXX` : null }, route: walkRoute.id, order: s.order,
      }))));
    }
    const e = summary.evidence;
    console.log(`snapshot of ${when(snap.fetchedAt)} ET  (${Date.now() - t0} ms)`);
    for (const f of summary.funnel) console.log(`  ${String(f.n).padStart(5)}  ${f.step}`);
    const r = summary.routes;
    console.log(`routes: ${r.count} days, ${r.doors} doors, median ${r.medianDoors} doors, ${r.medianKm} km, ${r.medianHours} h; ${r.unrouted} qualified doors off the walking days (in the import as a call list)`);
    console.log(`by borough: ${JSON.stringify(r.byBoro)}`);
    console.log(`sites: ${summary.sites.count} (${summary.sites.filings} filings) ${JSON.stringify(summary.sites.byKind)}; established places with fresh permits ${summary.repermits}; franchise units ${summary.franchiseUnits}; owner groups ${summary.ownerGroups}`);
    console.log(`scores: ${summary.scoreRange.min.toFixed(2)} to ${summary.scoreRange.max.toFixed(2)}`);
    console.log(`evidence: rank correlation ${e.rho} over ${e.rhoN} permits; first inspected in ${e.year}: ${e.operational} already operating, ${e.notYet} not yet`);
    console.log(`top neighborhoods: ${summary.hoods.slice(0, 6).map((h) => `${h.hood} (${h.boro}) ${h.qualified}`).join("; ")}`);
    console.log(`walk check: route ${summary.walk.route} ${summary.walk.hood}, ${summary.walk.status}${summary.walk.rate !== null ? `, hit rate ${(summary.walk.rate * 100).toFixed(0)}%` : ""}`);
    console.log(`wrote ${relative(ROOT, OUT)}/, ${relative(ROOT, CARD)} and docs/skipped.csv`);
    return;
  }
  if (cmd === "diff") {
    const snaps = listSnapshots();
    if (snaps.length < 2) { console.log(`only ${snaps.length} snapshot(s); run \`npm run fetch\` again after the city's next daily update to see the new doors`); return; }
    const prev = loadSnapshot(snaps.at(-2)), curr = loadSnapshot(snaps.at(-1));
    const { d, fresh, doors, refilings, skipped, left } = newDoors(prev, curr);
    // Where the departures went, by the CAMIS that actually left.
    let outcome = new Map<string, { date: string; type: string }>(), looked = true;
    try { outcome = await lookupFirstInspections(left.map((l) => l.row.camis)); } catch { looked = false; }
    const inspected = loadInspected().places;
    const fates = left.map((l) => (looked ? departureFate(l.row, outcome.get(l.row.camis), inspected) : "lookup failed, rerun diff"));
    mkdirSync(OUT, { recursive: true });
    const tag = stamp(curr.fetchedAt);
    const doorFile = join(OUT, `new_doors_${tag}.csv`), leftFile = join(OUT, `left_list_${tag}.csv`);
    writeFileSync(doorFile, hubspotCsv(doors.map((s) => ({ s }))));
    writeFileSync(leftFile, [csvRow(["camis", "name", "address", "borough", "phone", "was a qualified door", "what happened"]),
      ...left.map((l, i) => csvRow([l.row.camis, safeText(titleCase(String(l.row.dba ?? ""))), safeText(titleCase(`${l.row.building ?? ""} ${l.row.street ?? ""}`.trim())),
        l.row.boro ?? "", normPhone(l.row.phone) ?? "", l.was?.qualified ? "yes" : "no", fates[i]]))].join("\r\n") + "\r\n");
    const opened = fates.filter((f) => !f.startsWith("no inspection") && !f.startsWith("lookup")).length;
    console.log(`${when(d.from)} to ${when(d.to)} ET`);
    console.log(`  ${fresh.length} new applications: ${doors.length} new qualified doors (${relative(ROOT, doorFile)}), ${refilings} refilings of listed doors, ${skipped} skipped with reasons`);
    console.log(`  ${left.length} left the list: ${looked ? `${opened} inspected (under their own or another permit), ${left.length - opened} with no inspection on record` : "inspection lookup failed"} (${relative(ROOT, leftFile)})`);
    return;
  }
  if (cmd === "walk") {
    const file = join(VALID, "walk.csv");
    if (!existsSync(file)) {
      console.log("no validation/walk.csv yet. Copy validation/walk_template.csv to validation/walk.csv, walk the route, and fill status with one of:");
      for (const [k, v] of Object.entries(WALK_STATUSES)) console.log(`  ${k.padEnd(12)} ${v}`);
      return;
    }
    const p = pipeline(loadSnapshot());
    const w = readWalk(file, pickWalkRoute(p.routes)?.stops.map((s) => s.camis) ?? []);
    console.log(JSON.stringify(w, null, 2));
    return;
  }
  console.error(`unknown command ${cmd}; use fetch, run, diff or walk`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
