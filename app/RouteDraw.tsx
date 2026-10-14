"use client";
// The one animation: a route day draws itself, and each door lights up as the walk reaches it.
import { useState } from "react";
import type { CardRoute } from "./card";

const W = 520, H = 400, PAD = 36, DUR = 7, MIN_GAP = 19;

/** Display name: drop the legal suffix ("Happy Seafood Restaurant INC" reads as "Happy Seafood Restaurant"). */
export const shortName = (n: string) => n.replace(/[,\s]+(INC|LLC|CORP|CORPORATION|LTD)\.?$/i, "").trim();

/**
 * Two doors at one address would hide each other, so markers closer than MIN_GAP pixels get pushed apart a little.
 * The path runs through the nudged markers; the scale bar still measures the true map.
 */
function spread(pts: [number, number][]): [number, number][] {
  const p = pts.map(([x, y]) => [x, y] as [number, number]);
  for (let it = 0; it < 80; it++) {
    let moved = false;
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      let dx = p[j][0] - p[i][0], dy = p[j][1] - p[i][1];
      let d = Math.hypot(dx, dy);
      if (d >= MIN_GAP) continue;
      if (d < 1e-6) { const a = (j * 2.4) % (2 * Math.PI); dx = Math.cos(a); dy = Math.sin(a); d = 1; }
      const push = (MIN_GAP - d) / 2 / d;
      p[i][0] -= dx * push; p[i][1] -= dy * push;
      p[j][0] += dx * push; p[j][1] += dy * push;
      moved = true;
    }
    if (!moved) break;
  }
  return p;
}

export function RouteDraw({ route, context }: { route: CardRoute; context: [number, number, number][] }) {
  const [run, setRun] = useState(0);

  // Fit the route into the box, keeping the map's aspect ratio.
  const lats = route.stops.map((s) => s.lat), lons = route.stops.map((s) => s.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats), lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const k = Math.cos(((latMin + latMax) / 2) * (Math.PI / 180));
  const s = Math.min((W - 2 * PAD) / ((lonMax - lonMin) * k || 1e-9), (H - 2 * PAD) / (latMax - latMin || 1e-9));
  const ox = (W - (lonMax - lonMin) * k * s) / 2, oy = (H - (latMax - latMin) * s) / 2;
  const x = (lon: number) => ox + (lon - lonMin) * k * s;
  const y = (lat: number) => oy + (latMax - lat) * s;

  const pts = spread(route.stops.map((st) => [x(st.lon), y(st.lat)]));
  const seg = pts.map((p, i) => (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0));
  const total = seg.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const delay = seg.map((d) => { acc += d; return (acc / total) * DUR; });

  const inView = context.filter(([la, lo]) => { const px = x(lo), py = y(la); return px > 4 && px < W - 4 && py > 4 && py < H - 4; });
  // 1 degree of latitude is about 111,320 m, so this many pixels is 500 m on the ground.
  const bar = (500 * s) / 111320;

  return (
    <>
      <div className="rd-map" key={`m${run}`}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Walking route ${route.id} in ${route.hood}, ${route.stops.length} doors`}>
          {inView.map(([la, lo, q], i) => (
            <circle key={i} cx={x(lo)} cy={y(la)} r={q ? 2.4 : 2} className={q ? "ctx-q" : "ctx"} />
          ))}
          <polyline className="rd-path" pathLength={1} points={pts.map((p) => p.join(",")).join(" ")} style={{ animationDuration: `${DUR}s` }} />
          {pts.map(([px, py], i) => (
            <g key={i} className={`rd-stop${i === 0 ? " first" : ""}`} style={{ animationDelay: `${delay[i]}s` }}>
              <circle cx={px} cy={py} r={9} />
              <text x={px} y={py + 3.2} textAnchor="middle">{i + 1}</text>
            </g>
          ))}
          <g className="rd-scale" transform="translate(52 40)">
            <path d={`M0 -5 V0 H${bar} V-5`} />
            <text x={bar / 2} y={-8} textAnchor="middle">500 m</text>
          </g>
          <g className="rd-north" transform="translate(24 26)">
            <path d="M0 -10 L5 4 L0 1 L-5 4 Z" />
            <text x={0} y={17} textAnchor="middle">N</text>
          </g>
        </svg>
        <button className="rd-replay" onClick={() => setRun((r) => r + 1)} aria-label="Replay the walk">Replay walk</button>
      </div>
      <ol className="rd-list" key={`l${run}`}>
        {route.stops.map((st, i) => (
          <li key={i} style={{ animationDelay: `${delay[i]}s` }}>
            <span className="rd-n">{i + 1}</span>
            <span className="rd-name">{shortName(st.n)}</span>
            <span className="rd-type">{st.t}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
