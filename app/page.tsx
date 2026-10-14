import { card, fmt, projector, bounds } from "./card";
import { RouteDraw } from "./RouteDraw";

const S = card.summary;
const walkRoute = card.routes.find((r) => r.id === S.walk.route) ?? card.routes[0];
const funnelTop = S.funnel[0].n;
const qualified = S.funnel[S.funnel.length - 2].n;
const snapDate = new Date(S.snapshot.fetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const pct = (x: number) => `${Math.round(x * 100)}%`;

const E = S.evidence; // computed by the engine on every run from the city's inspected records

const BORO_LABELS: [string, number, number][] = [
  ["Manhattan", 40.80, -74.03], ["Bronx", 40.875, -73.86], ["Queens", 40.715, -73.79],
  ["Brooklyn", 40.625, -73.935], ["Staten Island", 40.555, -74.215],
];

const STOCK = ["Company name", "Phone Number", "Street Address", "City", "State/Region", "Postal Code", "Country/Region", "Industry", "Lifecycle Stage", "Lead Status"];
const CUSTOM = ["filed name", "business type", "neighborhood", "score", "route", "stop", "peers inspected", "status", "shared phone", "owner group", "camis", "source"];

function CityMap() {
  const pts = card.points.map(([lat, lon]) => ({ lat, lon }));
  const p = projector(bounds(pts, 0.02), 560, 8);
  const wb = bounds(walkRoute.stops, 0.25);
  const rx = p.x(wb.lonMin), ry = p.y(wb.latMax), rw = p.x(wb.lonMax) - rx, rh = p.y(wb.latMin) - ry;
  return (
    <svg className="city" viewBox={`0 0 ${p.width} ${p.height}`} role="img" aria-label={`Map of ${fmt(card.points.length)} mapped permit applications across New York City`}>
      {card.points.filter((d) => !d[2]).map(([la, lo], i) => <circle key={`s${i}`} cx={p.x(lo)} cy={p.y(la)} r={1.5} className="pt-skip" />)}
      {card.points.filter((d) => d[2]).map(([la, lo], i) => <circle key={`q${i}`} cx={p.x(lo)} cy={p.y(la)} r={1.7} className="pt-q" />)}
      {BORO_LABELS.map(([name, la, lo]) => <text key={name} x={p.x(lo)} y={p.y(la)} className="boro">{name}</text>)}
      <rect x={rx} y={ry} width={rw} height={rh} rx={4} className="walk-box" />
      <text x={rx + rw + 6} y={ry + rh / 2 + 4} className="walk-label">{walkRoute.id}</text>
    </svg>
  );
}

function Truth() {
  const w = S.walk;
  if (w.status === "pending" || w.status === "stale") {
    return (
      <>
        <div>
          <div className="eyebrow">Ground truth</div>
          <h2>Hand check pending</h2>
          <p>
            The data cannot say which doors are still a live prospect, so route {w.route} is the check route: {w.planned} doors,
            each to be marked pre open, just opened, open a while, closed, or not found, on a rep&apos;s first walk or as the
            city&apos;s first inspections come in. The hit rate lands here with a 95% Wilson interval; until then this card shows no number.
          </p>
        </div>
        <div className="truth-badge pending">pending</div>
      </>
    );
  }
  return (
    <>
      <div>
        <div className="eyebrow">Ground truth</div>
        <h2>{w.hits} of {w.checked} doors were still a live prospect</h2>
        <p>
          Route {w.route}, {w.hood}: {w.checked} of {w.planned} doors checked by hand. Hit rate {pct(w.rate ?? 0)}, 95%
          Wilson interval {pct(w.ci95!.low)} to {pct(w.ci95!.high)}. Pre open {w.counts.pre_open}, just opened {w.counts.just_opened},
          open a while {w.counts.open_old}, closed {w.counts.closed}, not found {w.counts.not_found}.
        </p>
      </div>
      <div className={`truth-badge ${w.status}`}>{pct(w.rate ?? 0)}</div>
    </>
  );
}

export default function Page() {
  const r = S.routes;
  // Only the dots around the hand check route go to the client component.
  const nb = bounds(walkRoute.stops, 0.6);
  const ctx = card.points.filter(([la, lo]) => la >= nb.latMin && la <= nb.latMax && lo >= nb.lonMin && lo <= nb.lonMax);
  return (
    <main>
      <header className="top">
        <div className="brand"><span className="mark">preopen</span><span className="pill">for a1mobile</span></div>
        <div className="meta">NYC Open Data, snapshot of {snapDate}</div>
      </header>

      <section className="card hero">
        <div className="hero-copy">
          <div className="eyebrow">GTM Engineer, NYC · work sample</div>
          <h1>{fmt(funnelTop)} NYC food businesses are so new the Health Department has not inspected them yet.</h1>
          <p className="lede">
            Most are already serving; a few are still building out. preopen keeps the {fmt(qualified)} a phone
            carrier can sell to and turns them into {fmt(r.count)} walkable door to door days and a HubSpot import.
          </p>
          <div className="stats">
            <div><b>{fmt(r.doors)}</b><span>doors on a route</span></div>
            <div><b>{fmt(r.count)}</b><span>route days</span></div>
            <div><b>{r.medianDoors}</b><span>doors a day, median</span></div>
            <div><b>{r.medianHours.toFixed(1)} h</b><span>a day, {r.medianKm.toFixed(1)} km on foot</span></div>
          </div>
        </div>
        <div className="hero-route">
          <div className="route-head">
            <div>
              <div className="eyebrow">Check route</div>
              <div className="route-title">{walkRoute.id} · {walkRoute.hood}, {walkRoute.boro}</div>
            </div>
            <div className="route-facts">{walkRoute.stops.length} doors · {walkRoute.walkKm.toFixed(1)} km · about {walkRoute.hours.toFixed(1)} h</div>
          </div>
          <RouteDraw route={walkRoute} context={ctx} />
          <div className="link route-link">
            Walk it in Google Maps:{" "}
            {walkRoute.maps.map((u, i) => (
              <span key={i}>{i ? " · " : ""}<a href={u} target="_blank" rel="noreferrer">leg {i + 1}</a></span>
            ))}
          </div>
        </div>
      </section>

      <section className="grid2">
        <div className="card">
          <h2>Where the doors are</h2>
          <p className="sub">Every mapped permit application in the city. Blue made the cut; grey was skipped, each with a stated reason.</p>
          <CityMap />
        </div>
        <div className="card">
          <h2>Densest neighborhoods</h2>
          <p className="sub">Qualified doors, and how many are on track: places whose permit number peers are getting first inspections now.</p>
          <table className="tbl">
            <thead><tr><th>Neighborhood</th><th>Borough</th><th className="num">Doors</th><th className="num">On track</th></tr></thead>
            <tbody>
              {S.hoods.slice(0, 10).map((h) => (
                <tr key={h.nta}><td>{h.hood}</td><td>{h.boro}</td><td className="num">{h.qualified}</td><td className="num">{pct(h.onTrack / h.qualified)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>From the city&apos;s list to a rep&apos;s day</h2>
        <p className="sub">Each step drops doors for a reason a sales lead would agree with. Every skipped business is listed with its reasons in docs/skipped.csv, so any cut can be audited.</p>
        <div className="funnel">
          {S.funnel.map((f, i) => (
            <div className="frow" key={i}>
              <div className="flabel">{cap(f.step)}</div>
              <div className="fbar"><div style={{ width: `${(f.n / funnelTop) * 100}%` }} className={i === S.funnel.length - 1 ? "last" : ""} /></div>
              <div className="fnum">{fmt(f.n)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid3">
        <div className="card">
          <div className="eyebrow">leads/route_sheets.txt</div>
          <h3>Route days</h3>
          <p>Each day fits under 6 hours: at most 25 doors, 10 minutes a door, walking at 4.8 km/h. Seeded at the densest block, grown from either end, untangled with 2 opt. Ranked by score per hour on the street. Maps links come in 5 stop legs so they open on a phone.</p>
          <table className="tbl small">
            <tbody>
              {card.routes.slice(0, 6).map((rt) => (
                <tr key={rt.id}><td className="mono">{rt.id}</td><td>{rt.hood}</td><td className="num">{rt.stops.length}</td><td className="num">{rt.walkKm.toFixed(1)} km</td><td><a href={rt.maps[0]} target="_blank" rel="noreferrer">leg 1</a></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="eyebrow">leads/hubspot_companies.csv</div>
          <h3>HubSpot import</h3>
          <p>Every qualified door: the routed ones in walking order, then the {fmt(S.routes.unrouted)} no walking day reached, as a call list. The first ten columns map to HubSpot&apos;s stock company properties with stock values (Industry Restaurants, Lifecycle Stage lead, Lead Status New); the rest become custom properties. HubSpot dedupes companies on domain, which a new place rarely has, so the city&apos;s permanent ID rides along (worth setting to require unique values) and the daily file only carries IDs it has not seen. A permit expediter&apos;s shared number goes in its own column, never in a company&apos;s Phone Number, and one owner&apos;s several new places share an owner group.</p>
          <div className="chips">
            {STOCK.map((c) => <span key={c} className="chip">{c}</span>)}
            {CUSTOM.map((c) => <span key={c} className="chip custom">preopen {c}</span>)}
          </div>
        </div>
        <div className="card">
          <div className="eyebrow">npm run fetch, then npm run diff</div>
          <h3>Built to run every morning</h3>
          <p>Pull today&apos;s list and compare it with yesterday&apos;s. New applications come out scored against the whole list, so a new kiosk at a known market or a refiling of a known place never shows up as a new door. Places that left the list are checked against the city&apos;s records: a first inspection on a date, or nothing, which means the application lapsed.</p>
          <p className="note">{S.sites.count} sites hold {fmt(S.sites.filings)} filings: holiday markets, Macy&apos;s Herald Square, food courts, airports, and caterer lines like one Charlotte number on dozens of corporate cafeterias. One operator call each, so they sit in leads/sites.csv, not on a walk. The city&apos;s own records also catch {fmt(S.repermits)} places it already inspects under another permit and {fmt(S.franchiseUnits)} franchise units the chain rule alone would miss.</p>
        </div>
      </section>

      <section className="card truth">
        <Truth />
      </section>

      <section className="card method">
        <h2>How it decides</h2>
        <div className="mgrid">
          <div><h4>New, not unopened</h4><p>The city&apos;s <a href="https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j" target="_blank" rel="noreferrer">restaurant inspection dataset</a> lists each restaurant that has applied for a permit but has not been inspected yet: {fmt(funnelTop)} today. New places are usually serving before the city gets to them: of the places first inspected in {E.year}, {pct(E.operational / (E.operational + E.notYet))} ({fmt(E.operational)} of {fmt(E.operational + E.notYet)}) were open at that first visit. So this is the city&apos;s list of its newest places, minus {fmt(S.repermits)} it already inspects under another permit.</p></div>
          <div><h4>On track or old</h4><p>Permit numbers (CAMIS) are issued roughly in order: for permits issued in recent years, rank correlation with first inspection date is {E.rho.toFixed(2)} across {fmt(E.rhoN)} places. A place whose permit number peers were inspected over a year ago is an old application: skipped because it is not new, not because it is dead (some still open late). It is an estimate and is labeled as one.</p></div>
          <div><h4>Fit</h4><p>The cuisine field is blank before inspection, so type is read from the name. Restaurants and pizza score highest (orders and reservations by phone), cafes next (a1mobile&apos;s own use case page). On this list scores run {S.scoreRange.min.toFixed(2)} to {S.scoreRange.max.toFixed(2)}, inside a hard cap of 0.40 to 0.95.</p></div>
          <div><h4>Known limits</h4><p>A venue bar, a hotel with no telltale name, or a chain with fewer than 5 NYC locations can still slip through: about 20 of the 200 doors on the top 8 days, with about 13 more unclear. That is why one Brooklyn day is the check route, and it will vouch for that day, not for every borough.</p></div>
        </div>
      </section>

      <footer>
        <span>Data: NYC Open Data, <a href="https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j" target="_blank" rel="noreferrer">DOHMH Restaurant Inspection Results</a> and <a href="https://data.cityofnewyork.us/City-Government/2010-Census-Tract-to-Neighborhood-Tabulation-Area-/8ius-dhrr" target="_blank" rel="noreferrer">2010 neighborhood names</a>.</span>
        <span>Built by Larry Wolters · github.com/CodedVibesX/preopen</span>
      </footer>
    </main>
  );
}
