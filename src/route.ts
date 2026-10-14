// Turn qualified prospects into walkable daily door to door routes.
//
// Method: in each borough, seed a route at the unrouted stop with the most unrouted neighbors within 400 m,
// grow it from either end by nearest neighbor until a day is full, then improve the order with 2 opt. Walking distance is the
// straight line distance times a 1.25 street grid factor. A day is capped by stops and by hours, where hours
// count walking at 4.8 km/h plus 10 minutes at each door.
import type { Route, Scored, Stop } from "./types.ts";

export const ROUTE_LIMITS = { maxStops: 25, maxHours: 6, minStops: 6, maxLegM: 1500, kmh: 4.8, minutesPerStop: 10, gridFactor: 1.25, seedRadiusM: 400 };

export function meters(a: { lat: number | null; lon: number | null }, b: { lat: number | null; lon: number | null }): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = ((b.lat as number) - (a.lat as number)) * rad;
  const dLon = ((b.lon as number) - (a.lon as number)) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat as number) * rad) * Math.cos((b.lat as number) * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const walkM = (a: Scored, b: Scored) => meters(a, b) * ROUTE_LIMITS.gridFactor;

export function pathKm(stops: Scored[]): number {
  let m = 0;
  for (let i = 1; i < stops.length; i++) m += walkM(stops[i - 1], stops[i]);
  return m / 1000;
}

export function hoursFor(stops: Scored[]): number {
  return pathKm(stops) / ROUTE_LIMITS.kmh + (stops.length * ROUTE_LIMITS.minutesPerStop) / 60;
}

/**
 * 2 opt on an open path: reverse any segment whose reversal shortens the walk, until no move helps. The day has no
 * fixed start or end, so the segment may run to either end of the path (the missing edge there costs nothing).
 */
export function twoOpt(path: Scored[]): Scored[] {
  const p = path.slice();
  const n = p.length;
  const d = (a: number, b: number) => (a < 0 || b >= n ? 0 : walkM(p[a], p[b]));
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = -1; i < n - 1; i++) {
      for (let k = i + 2; k < n + (i >= 0 ? 0 : -1); k++) {
        // reverse p[i+1..k]; edges (i, i+1) and (k, k+1) become (i, k) and (i+1, k+1)
        const before = d(i, i + 1) + d(k, k + 1);
        const after = d(i, k) + d(i + 1, k + 1);
        if (after + 1e-6 < before) {
          const seg = p.slice(i + 1, k + 1).reverse();
          p.splice(i + 1, seg.length, ...seg);
          improved = true;
        }
      }
    }
  }
  return p;
}

/**
 * Google Maps walking links, 5 stops a leg: Google allows only 3 waypoints when the link opens in a phone browser,
 * and a rep on foot opens it on a phone. Legs share an end stop so they connect.
 */
function mapsLinks(stops: Scored[]): string[] {
  const links: string[] = [];
  for (let i = 0; i < stops.length - 1; i += 4) {
    const chunk = stops.slice(i, i + 5);
    if (chunk.length < 2) break;
    const ll = (s: Scored) => `${s.lat!.toFixed(6)},${s.lon!.toFixed(6)}`;
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("origin", ll(chunk[0]));
    url.searchParams.set("destination", ll(chunk[chunk.length - 1]));
    if (chunk.length > 2) url.searchParams.set("waypoints", chunk.slice(1, -1).map(ll).join("|"));
    url.searchParams.set("travelmode", "walking");
    links.push(url.toString());
  }
  return links;
}

function mode(values: (string | null)[]): string {
  const c = new Map<string, number>();
  for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/**
 * What a day on the street is worth: the summed score of its doors per hour, counting 45 minutes to reach the first
 * door, so a short day does not outrank a full one.
 */
export const dayValue = (r: Route) => r.stops.reduce((a, s) => a + s.score, 0) / (r.hours + 0.75);

const BORO_CODE: Record<string, string> ={ Manhattan: "MN", Brooklyn: "BK", Queens: "QN", Bronx: "BX", "Staten Island": "SI" };

export function buildRoutes(qualified: Scored[]): { routes: Route[]; unrouted: Scored[] } {
  const L = ROUTE_LIMITS;
  const routes: Route[] = [];
  const unrouted: Scored[] = [];
  const byBoro = new Map<string, Scored[]>();
  for (const s of qualified) (byBoro.get(s.boro) ?? byBoro.set(s.boro, []).get(s.boro)!).push(s);

  for (const [boro, pool] of [...byBoro.entries()].sort()) {
    // Neighbor lists within the seed radius, computed once; counts drop as stops get routed.
    const near = new Map<Scored, Scored[]>(pool.map((a) => [a, pool.filter((b) => a !== b && meters(a, b) <= L.seedRadiusM)]));
    const count = new Map<Scored, number>(pool.map((a) => [a, near.get(a)!.length]));
    const left = new Set(pool);
    const take = (s: Scored) => { left.delete(s); for (const b of near.get(s)!) count.set(b, count.get(b)! - 1); };
    let n = 0;
    while (left.size) {
      // seed: the unrouted stop with the most unrouted neighbors, ties to the higher score
      let seed: Scored | null = null;
      for (const a of left) if (!seed || count.get(a)! > count.get(seed)! || (count.get(a) === count.get(seed) && a.score > seed.score)) seed = a;
      const path: Scored[] = [seed!];
      take(seed!);
      // Grow from whichever end has the closer unrouted door, so a dead end on one side does not end the day.
      while (path.length < L.maxStops && left.size) {
        const head = path[0], tail = path[path.length - 1];
        let next: Scored | null = null, d = Infinity, atHead = false;
        for (const b of left) {
          const mt = walkM(tail, b), mh = walkM(head, b);
          if (mt < d) { d = mt; next = b; atHead = false; }
          if (mh < d) { d = mh; next = b; atHead = true; }
        }
        if (!next) break;
        // a single leg longer than 1.5 km is a different neighborhood: the day stops growing
        if (d > L.maxLegM) break;
        const grown = atHead ? [next, ...path] : [...path, next];
        if (hoursFor(grown) > L.maxHours) break;
        path.splice(0, path.length, ...grown);
        take(next);
      }
      if (path.length < L.minStops) { unrouted.push(...path); continue; }
      const ordered = twoOpt(path);
      const id = `${BORO_CODE[boro] ?? "XX"}${String(++n).padStart(2, "0")}`;
      const stops: Stop[] = ordered.map((s, i) => ({ ...s, route: id, order: i + 1 }));
      routes.push({
        id, boro,
        hood: mode(ordered.map((s) => s.hood)),
        stops,
        walkKm: Math.round(pathKm(ordered) * 100) / 100,
        hours: Math.round(hoursFor(ordered) * 100) / 100,
        mapsLinks: mapsLinks(ordered),
      });
    }
  }
  // Best days first: the most score per hour on the street, so a day of strong fits beats a day of weak ones.
  routes.sort((a, b) => dayValue(b) - dayValue(a) || a.id.localeCompare(b.id));
  return { routes, unrouted };
}
