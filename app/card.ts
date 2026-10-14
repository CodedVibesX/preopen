// Shape of app/card.json (written by `npm start`) and the small geometry the page needs.
import raw from "./card.json";

export interface CardStop { n: string; t: string; f: string; a: string; lat: number; lon: number }
export interface CardRoute { id: string; boro: string; hood: string; walkKm: number; hours: number; maps: string[]; stops: CardStop[] }
export interface Card {
  summary: {
    snapshot: { fetchedAt: string; source: string; rows: number };
    funnel: { step: string; n: number }[];
    withPhone: number;
    qualifiedByFreshness: Record<string, number>;
    routes: { count: number; doors: number; unrouted: number; medianDoors: number; medianKm: number; medianHours: number; byBoro: Record<string, number> };
    hoods: { nta: string; hood: string; boro: string; qualified: number; onTrack: number; routed: number }[];
    scoreRange: { min: number; max: number };
    repermits: number;
    franchiseUnits: number;
    established: { fresh: number; alreadyOpen: number; sameLine: number };
    ownerGroups: number;
    evidence: { rho: number; rhoN: number; year: string; operational: number; notYet: number };
    sites: { count: number; filings: number; byKind: Record<string, number>; top: { kind: string; where: string; boro: string; hood: string; filings: number; businesses: number; sample: string[] }[] };
    walk: { route: string | null; hood: string | null; status: string; planned: number; checked: number; hits: number; rate: number | null; ci95: { low: number; high: number } | null; counts: Record<string, number>; offRoute: number };
  };
  points: [number, number, number][];
  routes: CardRoute[];
}

export const card = raw as unknown as Card;

export const fmt = (n: number) => n.toLocaleString("en-US");

/** Equirectangular projection scaled for NYC's latitude, fit to a target width. */
export function projector(b: { latMin: number; latMax: number; lonMin: number; lonMax: number }, width: number, pad = 0) {
  const k = Math.cos(((b.latMin + b.latMax) / 2) * (Math.PI / 180));
  const s = (width - 2 * pad) / ((b.lonMax - b.lonMin) * k);
  const height = (b.latMax - b.latMin) * s + 2 * pad;
  return {
    width, height,
    x: (lon: number) => pad + (lon - b.lonMin) * k * s,
    y: (lat: number) => pad + (b.latMax - lat) * s,
  };
}

export function bounds(pts: { lat: number; lon: number }[], padFrac = 0) {
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const p of pts) {
    latMin = Math.min(latMin, p.lat); latMax = Math.max(latMax, p.lat);
    lonMin = Math.min(lonMin, p.lon); lonMax = Math.max(lonMax, p.lon);
  }
  const dl = (latMax - latMin) * padFrac, dn = (lonMax - lonMin) * padFrac;
  return { latMin: latMin - dl, latMax: latMax + dl, lonMin: lonMin - dn, lonMax: lonMax + dn };
}
