// Outputs: a HubSpot company import, a printable route sheet, and the JSON the demo card reads.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Route, Scored } from "./types.ts";
import { displayName } from "./clean.ts";

const TYPE_LABEL: Record<string, string> = {
  restaurant: "Restaurant", pizza: "Pizza", cafe: "Cafe", bakery: "Bakery", fast_casual: "Fast casual",
  bar: "Bar", dessert: "Dessert", juice: "Juice bar", deli_market: "Deli or market", institutional: "Institutional",
};

/** RFC 4180 field: quote when needed, double inner quotes. */
export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvField).join(",");

/**
 * Names and addresses are typed by applicants, so a cell starting with = + - or @ would run as a formula when the file
 * is opened in a spreadsheet. A leading apostrophe keeps it text. Phone cells are left alone: HubSpot wants the +.
 */
export const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export const HUBSPOT_HEADER = ["Company name", "Phone Number", "Street Address", "City", "State/Region", "Postal Code",
  "Country/Region", "Industry", "Lifecycle Stage", "Lead Status", "preopen filed name", "preopen business type",
  "preopen neighborhood", "preopen score", "preopen route", "preopen stop", "preopen peers inspected", "preopen status",
  "preopen shared phone", "preopen owner group", "preopen camis", "preopen source"];

/**
 * HubSpot company import. The first ten columns use HubSpot's default company property labels, and Industry,
 * Lifecycle Stage and Lead Status carry stock option values, so the importer maps them by name. The preopen columns
 * become custom properties on the import's "create a new property" step. HubSpot dedupes companies on domain, which a
 * place that just opened rarely has, so the stable key here is preopen camis, the city's permanent ID for the place,
 * and the daily diff only ever emits CAMIS numbers it has not seen before. A phone shared by 3+ addresses is an
 * expediter's line, so it goes in "preopen shared phone" instead of the company's Phone Number. One owner behind several
 * new locations shares "preopen owner group", so the locations can be tied to one account.
 */
export function hubspotCsv(stops: { s: Scored; route?: string; order?: number }[]): string {
  const lines = [csvRow(HUBSPOT_HEADER)];
  for (const { s, route, order } of stops) {
    const own = s.phoneShared ? "" : s.phone ?? "", shared = s.phoneShared ? s.phone ?? "" : "";
    lines.push(csvRow([safeText(displayName(s.name)), own, safeText(s.address), s.boro === "Manhattan" ? "New York" : s.boro,
      "NY", s.zip, "United States", "Restaurants", "lead", "NEW", safeText(s.name), TYPE_LABEL[s.bizType], s.hood ?? "",
      s.score, route ?? "", order ?? "", s.peerMonth, s.freshness, shared, s.owner ?? "", s.camis,
      "NYC DOHMH open data: applied for a permit, not yet inspected"]));
  }
  return lines.join("\r\n") + "\r\n";
}

export const routeStops = (routes: Route[]) => routes.flatMap((r) => r.stops.map((s) => ({ s, route: r.id, order: s.order })));

/** What a rep should dial: never an expediter's shared line. */
const phoneLabel = (s: Scored) => (!s.phone ? "no phone on record" : s.phoneShared ? "phone on file is an expediter's, ask in person" : s.phone);

export function routeSheet(routes: Route[]): string {
  const out: string[] = [];
  for (const r of routes) {
    out.push(`ROUTE ${r.id}  ${r.boro}  ${r.hood}  ${r.stops.length} doors  ${r.walkKm} km walking  about ${r.hours} h`);
    r.mapsLinks.forEach((u, i) => out.push(`  leg ${i + 1}: ${u}`));
    for (const s of r.stops) out.push(`  ${String(s.order).padStart(2)}. ${displayName(s.name)}  ${s.address}  ${phoneLabel(s)}  [${TYPE_LABEL[s.bizType]}, ${s.freshness}${s.owner ? `, owner group ${s.owner}` : ""}]`);
    out.push("");
  }
  return out.join("\n");
}

/** Every skipped business and why, so a sales lead can audit any cut. The committed copy leaves phone numbers out. */
export function skippedCsv(scored: Scored[], withPhone: boolean): string {
  const head = ["camis", "name", "address", "borough", ...(withPhone ? ["phone"] : []), "reasons"];
  const rows = scored.filter((s) => !s.qualified).sort((a, b) => Number(a.camis) - Number(b.camis))
    .map((s) => csvRow([s.camis, safeText(s.name), safeText(s.address), s.boro, ...(withPhone ? [s.phone ?? ""] : []), s.reasons.map((r) => r.replace(/^skip: /, "")).join("; ")]));
  return [csvRow(head), ...rows].join("\r\n") + "\r\n";
}

export function writeOutputs(dir: string, cardFile: string, routes: Route[], unrouted: Scored[], scored: Scored[], summary: object, featured: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  // Routed doors in walking order, then the qualified doors no walking day reached: still leads, as a call list.
  writeFileSync(join(dir, "hubspot_companies.csv"), hubspotCsv([...routeStops(routes), ...unrouted.map((s) => ({ s }))]));
  writeFileSync(join(dir, "route_sheets.txt"), routeSheet(routes));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  // The card only needs coordinates, names, types and route membership: no phone numbers leave the CSV.
  const shown = routes.filter((r, i) => i < 12 || featured.includes(r.id));
  const card = {
    summary,
    points: scored.filter((s) => s.lat !== null).map((s) => [Number(s.lat!.toFixed(5)), Number(s.lon!.toFixed(5)), s.qualified ? 1 : 0]),
    routes: shown.map((r) => ({ id: r.id, boro: r.boro, hood: r.hood, walkKm: r.walkKm, hours: r.hours, maps: r.mapsLinks,
      // The card shows names with dashes as spaces ("Deal-Good-1" reads "Deal Good 1"); the import keeps the exact name.
      stops: r.stops.map((s) => ({ n: displayName(s.name).replace(/\s*[-‐-―]+\s*/g, " ").trim(), t: TYPE_LABEL[s.bizType], f: s.freshness, a: s.address, lat: Number(s.lat!.toFixed(5)), lon: Number(s.lon!.toFixed(5)) })) })),
  };
  mkdirSync(dirname(cardFile), { recursive: true });
  writeFileSync(cardFile, JSON.stringify(card));
}
