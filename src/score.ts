// Score each prospect for a1mobile's door to door team.
//
// a1mobile sells a $99 a month AI business phone line, and its own site lists "restaurants, cafes" first.
// The best door is an independent food business that just opened or is about to, and that a rep can actually reach.
// Every point in the score has a stated reason, and the score is capped: it never claims certainty.
import type { BizType, Prospect, Scored } from "./types.ts";
import { isNycPhone, isParkConcession, isSeasonal } from "./clean.ts";

export const SCORE_FLOOR = 0.4;
export const SCORE_CEIL = 0.95;

/** How well each business type fits a phone line plus AI receptionist that takes bookings and orders. */
const TYPE_FIT: Record<BizType, number> = {
  restaurant: 0.16,    // reservations, takeout orders, catering calls
  pizza: 0.16,         // phone orders are the core of the business
  cafe: 0.14,          // named on a1mobile's own site, with a cafes use case page
  bakery: 0.12,        // custom cake and catering orders by phone
  fast_casual: 0.12,
  bar: 0.10,           // events and private bookings
  dessert: 0.08,
  juice: 0.06,
  deli_market: 0.06,   // phone matters less to a counter business
  institutional: 0,    // a school or hospital kitchen does not buy its own phone line
};

const FRESH: Record<Prospect["freshness"], number> = { on_track: 0.2, behind: 0.1, stalled: 0 };
const FRESH_TEXT: Record<Prospect["freshness"], string> = {
  on_track: "on track: places with neighboring permit numbers are getting first inspections now",
  behind: "behind: its permit number peers were inspected months ago",
  stalled: "old application",
};

const SITE_TEXT: Record<NonNullable<Prospect["siteKind"]>, (n: number) => string> = {
  address: (n) => `one of ${n} filings at one address: a market, food hall, concession or office address`,
  cluster: (n) => `one of ${n} filings in one building or market under several address spellings`,
  phone: (n) => `one of ${n} filings on one out of town phone line across several addresses: a contract caterer, concession operator or chain head office`,
};

export function score(p: Prospect): Scored {
  const reasons: string[] = [];
  let s = SCORE_FLOOR;

  const fit = TYPE_FIT[p.bizType];
  s += fit;
  reasons.push(`${p.bizType.replace("_", " ")} fit +${fit.toFixed(2)}`);

  const fr = FRESH[p.freshness];
  s += fr;
  reasons.push(`${FRESH_TEXT[p.freshness]} (peers est. ${p.peerMonth}) +${fr.toFixed(2)}`);

  if (p.newest) { s += 0.04; reasons.push("permit number newer than every place inspected so far, so it applied very recently +0.04"); }
  const carried = p.flags.some((f) => f.startsWith("phone carried over"));
  if (isNycPhone(p.phone) && !p.phoneShared && !carried) { s += 0.05; reasons.push("its own NYC phone on record, can call ahead +0.05"); }

  // Disqualifiers are reasons, not silent drops, so a reviewer can see why a door was skipped.
  const disq: string[] = [];
  if (p.chain) disq.push(`chain with ${p.chainLocations} active NYC locations buys phones centrally`);
  if (p.bizType === "institutional") disq.push("institutional, corporate, hotel or airport kitchen: the buyer is not an owner at the counter");
  if (p.siteKind) disq.push(SITE_TEXT[p.siteKind](p.siteSize) + ", so it goes to the sites list, not a walking route");
  if (p.repermit) {
    const r = p.repermit;
    disq.push(r.newer ? `already open: the city inspected ${r.name} here under a newer permit (CAMIS ${r.camis}) on ${r.first}`
      : r.byPhone ? `the same operator: its phone is the line of ${r.name}, which the city has inspected at this storefront since at least ${r.first} (CAMIS ${r.camis})`
      : `an established place with a fresh permit, not a new place: the city has inspected ${r.name} here since at least ${r.first} (CAMIS ${r.camis})`);
  }
  if (p.franchise) disq.push(`a franchise unit: its phone also sits on inspected ${p.franchise} stores, so the operator buys centrally`);
  if (p.building) disq.push(`in the same building as an inspected "${p.building}": a hotel, office or venue kitchen, bought by the building's operator`);
  if (isParkConcession(p.address, p.zip)) disq.push("a park concession, bought by the concessionaire");
  if (isSeasonal(p.rawName, p.address)) disq.push("a holiday kiosk that closes in weeks");
  if (p.freshness === "stalled") disq.push("an old application: its permit number peers were inspected over a year ago, so it is not new (some still open late)");
  if (p.lat === null) disq.push("cannot be placed on a walking route");
  if (p.boro === "Unknown") disq.push("borough unknown");

  s = Math.min(SCORE_CEIL, Math.max(SCORE_FLOOR, s));
  return { ...p, score: Math.round(s * 100) / 100, qualified: disq.length === 0, reasons: disq.length ? disq.map((d) => `skip: ${d}`) : reasons };
}

export function scoreAll(ps: Prospect[]): Scored[] {
  return ps.map(score).sort((a, b) => b.score - a.score || Number(b.camis) - Number(a.camis));
}
