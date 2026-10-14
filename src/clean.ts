// Turn raw Health Department rows into prospects a door to door rep can act on.
import type { BizType, Prospect, RawRow } from "./types.ts";
import { normName, type InspectedPlace } from "./data.ts";
import type { RecencyModel } from "./recency.ts";

/** Generous box around the five boroughs; anything outside is a geocoding error. */
const NYC = { latMin: 40.47, latMax: 40.93, lonMin: -74.27, lonMax: -73.68 };

const ZIP_BORO: [RegExp, string][] = [
  [/^10(0|1|2)\d\d$/, "Manhattan"],
  [/^104\d\d$/, "Bronx"],
  [/^112\d\d$/, "Brooklyn"],
  [/^103\d\d$/, "Staten Island"],
  [/^11(0|1|3|4|6)\d\d$/, "Queens"],
];

/** New York City area codes. A number outside them is often a consultant, an expediter or a head office. */
export const NYC_AREA_CODES = new Set(["212", "332", "646", "917", "718", "347", "929"]);
export const isNycPhone = (e164: string | null) => !!e164 && NYC_AREA_CODES.has(e164.slice(2, 5));

/** Ten digit US number, not all one digit, not a 555 placeholder, as E.164. */
export function normPhone(raw: string | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  if (d.length !== 10) return null;
  if (/^(\d)\1{9}$/.test(d)) return null;
  if (/^\d{3}555\d{4}$/.test(d)) return null;
  if (d[0] === "0" || d[0] === "1") return null;
  return `+1${d}`;
}

/**
 * Text as the city stores it, minus control characters: an encoding slip upstream left U+001A ("substitute") where a
 * letter was ("M\u001aZIC"), which renders as a box. Nothing printable is ever a control character.
 */
export const cleanText = (s: string | undefined) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();

/** Building IDs like 1000000 or 4000000 are placeholders the city uses when it has no real building. */
export const realBin = (bin: string | undefined) => (bin && /^\d{7}$/.test(bin) && !/^[1-5]0{6}$/.test(bin) ? bin : null);

const ACRONYMS = /\b(Llc|Llp|Inc|Nyc|Ny|Jfk|Lga|Bbq|Ii|Iii|Iv|Usa)\b/g;

/** "BARRY'S WALL STREET" to "Barry's Wall Street", "L'ARTUSI" to "L'Artusi", "DÄN BAKERY & CAFÉ" to "Dän Bakery & Café". */
export function titleCase(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, pre, c) => pre + c.toUpperCase())
    .replace(/\b([LDO])(['’])(\p{Ll})/gu, (_, a, ap, b) => a + ap + b.toUpperCase())
    .replace(ACRONYMS, (m) => m.toUpperCase());
}

/** The name a rep would say out loud: "Happy Seafood Restaurant INC" is "Happy Seafood Restaurant". */
export const displayName = (n: string) => n.replace(/[,\s]+(INC|LLC|LLP|CORP|CORPORATION|LTD)\.?$/i, "").trim() || n;

/** Street address as a comparison key: "42w 42nd St" and "42 West 42 Street" are one place. */
export function addressKey(address: string, zip: string): string {
  const words: Record<string, string> = {
    W: "WEST", E: "EAST", N: "NORTH", S: "SOUTH", ST: "STREET", STR: "STREET", AVE: "AVENUE", AV: "AVENUE",
    PL: "PLACE", BLVD: "BOULEVARD", RD: "ROAD", PKWY: "PARKWAY", SQ: "SQUARE", BWAY: "BROADWAY", DR: "DRIVE", LN: "LANE",
  };
  const a = address.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/\b(\d+)(ST|ND|RD|TH)\b/g, "$1") // "42ND", "3RD": strip the ordinal first, so RD never reads as ROAD
    .replace(/(\d)([A-Z])/g, "$1 $2").replace(/([A-Z])(\d)/g, "$1 $2")
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/).filter(Boolean)
    .map((w) => words[w] ?? w)
    .join(" ")
    .replace(/^0+ /, "");
  return `${a}|${zip}`;
}
const hasAddress = (address: string) => !!address && !/^N\/?A\b/i.test(address);

// Order matters: the first match wins, so specific types come before the generic ones
// ("JUICE BAR" is a juice bar and "ICE CREAM BAR" is dessert, so both sit above the bar rule).
const TYPE_RULES: [BizType, RegExp][] = [
  // Kitchens whose buyer is an institution, a contract caterer, a hotel, a venue or a corporate office, not an owner
  // at the counter. Small owner run caterers and catering halls are NOT here: they take bookings by phone.
  ["institutional", /\b(SCHOOL|ACADEMY|UNIVERSITY|COLLEGE|CAMPUS|DINING HALL|DINING SERVICES|HOSPITAL|MEDICAL CENTER|HEALTH CENTER|NURSING|SENIOR CENTER|STADIUM|ARENA|CAFETERIA|EMPLOYEE|STAFF DINING|DAYCARE|DAY CARE|SHELTER|CORRECTIONAL|COMMISSARY|CONCESSIONS?|FOOD HALL|FOOD COURT|AMENITY|FOUNDATION|ASSOCIATION|ATHLETIC CLUB|ARAMARK|SODEXO|RESTAURANT ASSOCIATES|FLIK|GUCKENHEIMER|BON APPETIT MANAGEMENT|LEVY|DELAWARE NORTH|CENTERPLATE|CONFERENCE|MEETING ROOMS?|\d+(ST|ND|RD|TH)? (FL|FLR|FLOOR)(?! BAR)|CORPORATE|HOTELS?|RENAISSANCE|VOCO|BEST WESTERN|HILTON|MARRIOTT|HYATT|SHERATON|WESTIN|HOLIDAY INN|HAMPTON INN|CITIZENM|MOXY|DOUBLETREE|CONCOURSE|GATE \d+|AIRPORT|JFK|LGA|LAGUARDIA|THEATRE|THEATER|MUSEUM(?! BAR)|MEMBERS)\b/],
  ["cafe", /\b(CAFE|CAFFE|COFFEE|ESPRESSO|ROASTERS?|TEA HOUSE|TEAHOUSE|MATCHA)\b/],
  ["bakery", /\b(BAKERY|BAKE SHOP|BAKESHOP|PATISSERIE|PASTRY|BAGELS?|DONUTS?|DOUGHNUTS?|BREAD)\b/],
  ["pizza", /\b(PIZZA|PIZZERIA)\b/],
  ["juice", /\b(JUICE|SMOOTHIES?|ACAI)\b/],
  ["dessert", /\b(ICE CREAM|GELATO|DESSERTS?|SWEETS|CANDY|CHOCOLATE|BOBA|BUBBLE TEA|CREPES?|CAKES?|YOGURT)\b/],
  ["bar", /\b(BAR|PUB|PUBLIC HOUSE|TAVERN|LOUNGE|SALOON|BREWERY|BREWING|TAPROOM|WINE|COCKTAILS?|SPEAKEASY|BILLIARDS|POOL HALL|KARAOKE)\b/],
  ["deli_market", /\b(DELI|DELICATESSEN|GROCERY|BODEGA|MARKET|MINI MART|FOOD MART|SUPERMARKET|GOURMET)\b/],
  ["fast_casual", /\b(CHICKEN|WINGS|BURGERS?|TACOS?|HALAL|GYRO|SHAWARMA|EMPANADAS?|DUMPLINGS?|POKE|BOWLS?|SUSHI|RAMEN|NOODLES?)\b/],
];

/** Holiday kiosks close in weeks: not worth a phone line, so not worth a door. Read from the name and the address. */
export const SEASONAL = /\b(CHRISTMAS|SANTA CLAUS|SANTAS|HOLIDAY MARKET|HOLIDAY SHOP|WINTER VILLAGE)\b/;
export const isSeasonal = (dba: string, address = "") => SEASONAL.test(normName(dba)) || SEASONAL.test(normName(address));

/** Park drives and the park ZIP: concessions bought by a concessionaire, not an owner. */
export const isParkConcession = (address: string, zip: string) => zip === "10000" || /^[\d\s-]*(EAST|WEST|CENTER) DRIVE$/i.test(address.trim());

export function classify(dba: string): BizType {
  if (dba.includes("@")) return "institutional"; // "RA @ AMAZON": a caterer's unit inside a company
  const n = normName(dba);
  for (const [type, re] of TYPE_RULES) if (re.test(n)) return type;
  return "restaurant";
}

/** Words that, alone or together, make a name anyone can use ("GREAT WALL", "CRISPY BURGER", "1 50 FRESH PIZZA"). */
const GENERIC_TOKENS = new Set(("PIZZA PIZZERIA CHINESE CHINA RESTAURANT KITCHEN DELI DELICATESSEN GRILL CAFE COFFEE BAGEL BAGELS " +
  "BURGER BURGERS CHICKEN FRIED FRIES N AND FRESH CRISPY WOK NOODLE NOODLES SUSHI TACO TACOS GYRO GYROS HALAL FOOD FOODS " +
  "HOUSE EXPRESS CORNER SPOT BAR BAKERY KING KINGS GOLDEN GREAT WALL NEW NO MR STAR LUCKY FAMOUS ORIGINAL BEST TASTE OF " +
  "GARDEN DRAGON PALACE JOY HAPPY ROYAL PLUS SLICE SLICES PIE BBQ GOURMET MARKET GROCERY JUICE TEA BUBBLE HOT POT " +
  "DUMPLING DUMPLINGS SEAFOOD FISH WINGS SPICY SPICE SWEET HOME STYLE YUMMY STAND SHOP PLACE TRUCK CART EATS BITES BOX " +
  "STATION HUB LAB BISTRO DINER EATERY CUISINE FUSION ROOM " +
  // dining formats and dishes: they describe a menu, not a business ("SUSHI OMAKASE" and "OMAKASE ROOM" are strangers)
  "OMAKASE IZAKAYA TAQUERIA TRATTORIA OSTERIA BRASSERIE CANTINA PHO BANH BIRRIA TAPAS MEZZE DOSA BIRYANI KEBAB KABAB " +
  "SHAWARMA FALAFEL AREPA AREPAS RAMEN HOTPOT POKE").split(" "));

/**
 * Names that 5+ unrelated independents happen to share are not chains: "CHINA KING" on 40 storefronts is 40 owners.
 * Kennedy Fried Chicken has 78 NYC permits and 68 different phone numbers. Burger King is a real chain.
 */
export const GENERIC_NAMES = new Set(["POKE BOWL", "TASTE OF CHINA", "LUCKY STAR", "MR PIZZA", "NO 1 CHINESE RESTAURANT", "OASIS CAFE",
  "KENNEDY FRIED CHICKEN", "COOKIES N CREAM", "MARIOS PIZZA", "CROWN FRIED CHICKEN", "GOLDEN KRUST CARIBBEAN BAKERY AND GRILL"]);
const REAL_CHAINS = new Set(["BURGER KING", "GOLDEN KRUST", "GOLDEN KRUST CARIBBEAN BAKERY AND GRILL"]);
export function isGenericName(k: string): boolean {
  if (REAL_CHAINS.has(k)) return false;
  if (GENERIC_NAMES.has(k) || [...GENERIC_NAMES].some((g) => k.startsWith(g + " "))) return true;
  const t = k.split(" ").filter(Boolean);
  // Small numbers are generic ("1 50 FRESH PIZZA"); a three digit number is a brand ("375 CHICKEN N FRIES").
  return t.length > 0 && t.every((w) => GENERIC_TOKENS.has(w) || /^\d{1,2}$/.test(w));
}

/**
 * Chains: a name with 5+ NYC locations, counting the places the city already inspects plus the distinct addresses of
 * today's uninspected filings, because a chain entering New York shows up first as a stack of new filings.
 */
export function buildChains(inspected: InspectedPlace[], rows: RawRow[]): Map<string, number> {
  const places = new Map<string, Set<string>>();
  const add = (name: string | undefined, key: string) => { const k = normName(name); if (k) (places.get(k) ?? places.set(k, new Set()).get(k)!).add(key); };
  const known = new Set<string>();
  for (const q of inspected) { add(q.dba, `c:${q.camis}`); known.add(`${normName(q.dba)}|${addressKey(`${q.building} ${q.street}`, q.zip)}`); }
  for (const r of rows) {
    const key = addressKey(`${r.building ?? ""} ${r.street ?? ""}`, String(r.zipcode ?? ""));
    if (!known.has(`${normName(r.dba)}|${key}`)) add(r.dba, `a:${key}`); // a fresh permit at a known location is not a new location
  }
  return new Map([...places].filter(([k, s]) => s.size >= 5 && !isGenericName(k)).map(([k, s]) => [k, s.size]));
}

/**
 * Match against chain names: exact after normalizing, or the chain name followed by more words ("NAYA PARK SLOPE" is
 * a NAYA). The prefix rule needs 4+ letters so "KFC" only matches exactly. Generic shared names never count.
 */
export function chainSize(dba: string, chains: Map<string, number>): number {
  const n = normName(dba);
  const exact = chains.get(n);
  if (exact && !isGenericName(n)) return exact;
  let best = "";
  for (const k of chains.keys()) if (k.length >= 4 && k.length > best.length && !isGenericName(k) && n.startsWith(k + " ")) best = k;
  return best ? chains.get(best)! : 0;
}

export function inferBoro(boro: string | undefined, zip: string | undefined): { boro: string; inferred: boolean } {
  const b = String(boro ?? "").trim();
  if (b && b !== "0") return { boro: b, inferred: false };
  const z = String(zip ?? "").trim();
  for (const [re, name] of ZIP_BORO) if (re.test(z)) return { boro: name, inferred: true };
  return { boro: "Unknown", inferred: false };
}

/**
 * Thresholds. A site is 4+ filings at one address, or 5+ filings geocoded within 4 m of each other (one building under
 * several address spellings: neighboring storefronts sit 3 to 10 m apart with their own building IDs, while the
 * Bryant Park kiosks share one exact point). A phone line on 3+ different addresses is not a single storefront's line.
 */
export const SITE_MIN = 4;
export const CLUSTER_MIN = 5;
export const CLUSTER_M = 4;
export const PHONE_ADDRESSES = 3;

const planarM = (a: Prospect, b: Prospect) => {
  const dy = (a.lat! - b.lat!) * 111320;
  const dx = (a.lon! - b.lon!) * 111320 * Math.cos(a.lat! * (Math.PI / 180));
  return Math.hypot(dx, dy);
};

/**
 * Place, cuisine and entity words: they say where, what kind or what legal shell, not who. "TOP POT STATEN ISLAND" and
 * "POKE ISLAND GRILL" share ISLAND and nothing else; "CARIBBEAN SIBLINGS" and "BEST CARIBBEAN" share a cuisine.
 */
const PLACE_WORDS = new Set(("STATEN ISLAND BRONX BROOKLYN BKLYN QUEENS MANHATTAN HARLEM NORTH SOUTH EAST WEST STREET AVENUE " +
  "BOULEVARD ROAD PLACE SQUARE PARK SLOPE HEIGHTS HILL VILLAGE CITY YORK DOWNTOWN UPTOWN MIDTOWN WILLIAMSBURG BUSHWICK " +
  "GREENPOINT TRIBECA SOHO NOHO NOLITA CHELSEA ASTORIA FLUSHING JACKSON BAY RIDGE SUNSET TERMINAL STATION PLAZA CENTER " +
  "CENTRE BROADWAY LEXINGTON AMSTERDAM COLUMBUS MADISON FULTON CANAL ATLANTIC CARIBBEAN MEXICAN ITALIAN THAI INDIAN " +
  "JAPANESE KOREAN VIETNAMESE GREEK TURKISH LEBANESE PERUVIAN COLOMBIAN DOMINICAN JAMAICAN HAITIAN SOUL AMERICAN FRENCH " +
  "SPANISH LATIN ASIAN AFRICAN ETHIOPIAN AFGHAN KOSHER VEGAN CUBAN PUERTO RICAN MEDITERRANEAN EASTERN PAKISTANI " +
  "BANGLADESHI NEPALI TIBETAN SICHUAN SZECHUAN CANTONESE SHANGHAI TAIWANESE NATIONAL INTERNATIONAL GLOBAL ENTERPRISE " +
  "ENTERPRISES MANAGEMENT HOSPITALITY VENTURES CAPITAL BRANDS PARTNERS SERVICES TRADING CREAM").split(" "));
/** Street word spellings, so "AVE D PIZZERIA" and "AVENUE D PIZZERIA" read alike. */
const SPELL: Record<string, string> = { AVE: "AVENUE", AV: "AVENUE", ST: "STREET", BLVD: "BOULEVARD", RD: "ROAD", PL: "PLACE", SQ: "SQUARE", BKLYN: "BROOKLYN" };
const words = (name: string) => normName(name).split(" ").filter(Boolean).map((w) => SPELL[w] ?? w);
/** The words of an address, which never identify a business at that address ("148 NOBLE STREET" is not "THE NOBLE"). */
export const addressWords = (address: string) => new Set(addressKey(address, "").replace(/\|$/, "").split(" ").filter(Boolean));

/** Words that identify a business: no generic food word, no place, cuisine or entity word, no bare number. */
const coreTokens = (name: string, exclude: Set<string> = new Set()) => {
  const all = words(name).filter((w) => !GENERIC_TOKENS.has(w) && !PLACE_WORDS.has(w) && !exclude.has(w) && w !== "RESTAURANT" && w !== "LOUNGE");
  const named = all.filter((w) => !/^\d+$/.test(w));
  return named.length ? named : all;
};

const levenshtein1 = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};
/** One word, allowing a plural and, for longer words, a one letter typo ("BRICKSTOWN" and "BRICKTOWN"). */
const sameWord = (a: string, b: string) => {
  if (a === b) return true;
  const s = (w: string) => (w.length >= 4 ? w.replace(/S$/, "") : w);
  if (s(a) === s(b)) return true;
  return Math.min(a.length, b.length) >= 5 && levenshtein1(a, b);
};

/**
 * One business under two filings. The same name; or one name's identifying words all inside the other's, where a
 * single identifying word must lead both names ("98K" and "98K CHICKEN & BURGER", not "NORTH BAR" and "TRUE NORTH");
 * or, when a name is all generic words, one whole name inside the other ("ROYAL SEAFOOD" and "ROYAL SEAFOOD CAFE").
 * Words of the shared address never count.
 */
export function sameBusiness(a: string, b: string, exclude: Set<string> = new Set()): boolean {
  const wa = words(a), wb = words(b);
  if (wa.length && wa.join(" ") === wb.join(" ")) return true;
  const ca = coreTokens(a, exclude), cb = coreTokens(b, exclude);
  if (ca.length && cb.length) {
    const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
    const identifying = (w: string) => /[A-Z]{3,}|\d+[A-Z]+|[A-Z]+\d+/.test(w);
    if (!short.some(identifying)) return false;
    // A single word must be the leading identifying word of the other name ("RA AMAZON CAFE" leads with AMAZON).
    if (short.length === 1) return sameWord(short[0], long.find(identifying) ?? long[0]);
    return short.every((w) => long.some((v) => sameWord(w, v)));
  }
  // A name made only of generic words: whole name containment, two words or more.
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.length >= 2 && short.every((w) => long.some((v) => sameWord(w, v)));
}

/** The first identifying word of a name: shared by an owner's locations ("HUDSON CABIN"), not by an expediter's clients. */
const brandWord = (name: string) => coreTokens(name).find((w) => /[A-Z]{3,}/.test(w)) ?? null;

/**
 * Many filings in one spot are not a row of storefronts. They are a holiday market (Bryant Park and Union Square file
 * dozens of kiosks, under several spellings of one address), a food hall or food court, airport or stadium concessions,
 * or a management office whose address went on the permit. A rep walking there finds a kiosk or a lobby, so these
 * leave the walking routes for a sites list, where one call to the operator is the better play.
 *
 * One phone number on 3+ different addresses is not one storefront's line. With an out of town area code it is a
 * contract caterer, a concession operator or a chain's head office (one Charlotte number covers dozens of corporate
 * cafeterias), so those filings are sites too. With an NYC area code it is either one owner opening several places
 * (the names share a brand word: one account, many lines) or a permit expediter working for independents (the names
 * share nothing: the doors stay, and the number is kept out of the import's phone field).
 *
 * Overlapping groups merge into one site, so every filing belongs to at most one site and nothing is counted twice.
 * Counted over filings, before duplicates merge, so the numbers match "N filings".
 */
export function markSites(ps: Prospect[]): Prospect[] {
  const groups: { kind: NonNullable<Prospect["siteKind"]>; members: Prospect[] }[] = [];

  // one address, however it is spelled
  const byAddr = new Map<string, Prospect[]>();
  for (const p of ps) if (hasAddress(p.address)) { const k = addressKey(p.address, p.zip); (byAddr.get(k) ?? byAddr.set(k, []).get(k)!).push(p); }
  for (const g of byAddr.values()) if (g.length >= SITE_MIN) groups.push({ kind: "address", members: g });

  // one spot on the map: filings linked within CLUSTER_M of each other
  const mapped = ps.filter((p) => p.lat !== null);
  const parent = mapped.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < mapped.length; i++) for (let j = i + 1; j < mapped.length; j++) {
    if (Math.abs(mapped[i].lat! - mapped[j].lat!) > 0.0001) continue; // about 11 m: cheap prefilter
    if (planarM(mapped[i], mapped[j]) <= CLUSTER_M) parent[find(i)] = find(j);
  }
  const byCluster = new Map<number, Prospect[]>();
  mapped.forEach((p, i) => { const r = find(i); (byCluster.get(r) ?? byCluster.set(r, []).get(r)!).push(p); });
  for (const g of byCluster.values()) {
    if (g.length < CLUSTER_MIN) continue;
    // A real building holds the group together. A row of storefronts each on its own building ID that happen to geocode
    // to one point (Steinway Street's restaurant row) is not a site; nor is a lone member with a building of its own.
    const bins = new Map<string, number>();
    for (const p of g) if (p.bin) bins.set(p.bin, (bins.get(p.bin) ?? 0) + 1);
    if (bins.size >= 4) continue;
    const kept = g.filter((p) => !p.bin || bins.get(p.bin)! > 1);
    if (kept.length >= CLUSTER_MIN) groups.push({ kind: "cluster", members: kept });
  }

  // one phone line on several addresses
  const byPhone = new Map<string, Prospect[]>();
  for (const p of ps) if (p.phone) (byPhone.get(p.phone) ?? byPhone.set(p.phone, []).get(p.phone)!).push(p);
  for (const [phone, g] of byPhone) {
    const addresses = new Set(g.map((p) => addressKey(p.address, p.zip))).size;
    if (addresses < PHONE_ADDRESSES) continue;
    if (!isNycPhone(phone)) { groups.push({ kind: "phone", members: g }); continue; }
    const words = new Map<string, number>();
    for (const p of g) { const w = brandWord(p.rawName); if (w) words.set(w, (words.get(w) ?? 0) + 1); }
    const [top, n] = [...words].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (n >= 2 && n * 2 >= g.length) {
      const brand = titleCase(g.find((p) => brandWord(p.rawName) === top)!.rawName);
      for (const p of g) { p.owner = displayName(brand); p.flags.push(`one owner behind ${addresses} new locations on this phone (${displayName(brand)})`); }
    } else {
      for (const p of g) { p.phoneShared = addresses; p.flags.push(`phone on the application is shared by ${addresses} addresses, likely a permit expediter`); }
    }
  }

  // Overlapping places become one site: an address group and a cluster that share filings are the same building or
  // market, so they union. A phone line is not a place: it spans the city (one vendor at three holiday markets, one
  // caterer in forty towers) and would glue every site into one, so a phone site only takes filings no place claimed.
  // Every filing ends up in at most one site, and nothing is counted twice.
  const places = groups.filter((g) => g.kind !== "phone"), lines = groups.filter((g) => g.kind === "phone");
  const id = new Map<Prospect, number>(), up: number[] = [];
  const root = (i: number): number => (up[i] === i ? i : (up[i] = root(up[i])));
  for (const g of places) for (const p of g.members) if (!id.has(p)) { id.set(p, up.length); up.push(up.length); }
  for (const g of places) for (const p of g.members.slice(1)) up[root(id.get(p)!)] = root(id.get(g.members[0])!);
  const comps = new Map<string, { members: Set<Prospect>; kind: NonNullable<Prospect["siteKind"]>; best: number }>();
  for (const g of places) {
    const r = `place:${root(id.get(g.members[0])!)}`;
    const c = comps.get(r) ?? comps.set(r, { members: new Set(), kind: g.kind, best: 0 }).get(r)!;
    for (const p of g.members) c.members.add(p);
    if (g.members.length > c.best) { c.best = g.members.length; c.kind = g.kind; }
  }
  lines.forEach((g, i) => {
    const free = g.members.filter((p) => !id.has(p));
    if (free.length) comps.set(`line:${i}`, { members: new Set(free), kind: "phone", best: free.length });
  });
  for (const [r, c] of comps) {
    const key = `site:${[...c.members].map((p) => p.camis).sort()[0]}:${r}`;
    for (const p of c.members) {
      p.siteKind = c.kind; p.siteKey = key; p.siteSize = c.members.size;
      p.flags.push(c.kind === "address" ? `one of ${c.members.size} filings at one address`
        : c.kind === "cluster" ? `one of ${c.members.size} filings in one building or market`
        : `one of ${c.members.size} filings on an out of town phone line`);
    }
  }
  return ps;
}

/**
 * The same place sometimes files twice (a new LLC, a renamed entity, a new owner taking over the space): same address,
 * and either the names are one business (see sameBusiness) or both filings carry the same phone number. One door, so
 * keep the newest filing; it inherits a phone, an owner, an expediter flag or an institutional type only the older one had.
 * Different businesses at one address with different phones (two storefronts in one building) stay separate.
 */
export function mergeDuplicateFilings(ps: Prospect[]): Prospect[] {
  const byAddr = new Map<string, Prospect[]>();
  for (const p of ps) {
    const k = hasAddress(p.address) ? addressKey(p.address, p.zip) : `none:${p.camis}`;
    (byAddr.get(k) ?? byAddr.set(k, []).get(k)!).push(p);
  }
  const out: Prospect[] = [];
  for (const group of byAddr.values()) {
    const kept: Prospect[] = [];
    for (const p of group.sort((a, b) => Number(b.camis) - Number(a.camis))) {
      const twin = kept.find((k) => sameBusiness(p.rawName, k.rawName, addressWords(p.address)) || (!!p.phone && p.phone === k.phone));
      if (!twin) { kept.push(p); continue; }
      twin.flags.push(`duplicate filing merged: CAMIS ${p.camis} "${p.name}"`);
      if (!twin.phone && p.phone) { twin.phone = p.phone; twin.phoneShared = p.phoneShared; twin.owner = twin.owner ?? p.owner; }
      if (p.bizType === "institutional") twin.bizType = "institutional";
      if (p.siteSize > twin.siteSize) { twin.siteSize = p.siteSize; twin.siteKind = p.siteKind; twin.siteKey = p.siteKey; }
    }
    out.push(...kept);
  }
  // A corner storefront files under both of its addresses ("58 Marcy Avenue" and "357 Grand Street" are one Echo Lake):
  // the same name within 40 m is one door too.
  const byName = new Map<string, Prospect[]>();
  for (const p of out) if (p.lat !== null) { const n = normName(p.rawName); if (n) (byName.get(n) ?? byName.set(n, []).get(n)!).push(p); }
  const gone = new Set<Prospect>();
  for (const g of byName.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => Number(b.camis) - Number(a.camis));
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const [k, p] = [g[i], g[j]];
      if (gone.has(k) || gone.has(p) || planarM(k, p) > 40) continue;
      k.flags.push(`duplicate filing merged: CAMIS ${p.camis} "${p.name}" at ${p.address}`);
      if (!k.phone && p.phone) { k.phone = p.phone; k.phoneShared = p.phoneShared; k.owner = k.owner ?? p.owner; }
      if (p.bizType === "institutional") k.bizType = "institutional";
      if (p.siteSize > k.siteSize) { k.siteSize = p.siteSize; k.siteKind = p.siteKind; k.siteKey = p.siteKey; }
      gone.add(p);
    }
  }
  return out.filter((p) => !gone.has(p));
}

/**
 * Inspected names that mark a hotel or venue building: its new food permits belong to the building's operator.
 * An office tower's employee cafeteria is NOT on this list: the same building ID often holds real street level
 * restaurants (Bklyn Larder at Manhattan West), so a cafeteria upstairs says nothing about the door downstairs.
 */
const BUILDING_KITCHEN = /\b(ROOM SERVICE|IN ROOM DINING|LOBBY BAR|CONCESSIONS?|EMPLOYEE DINING|STAFF DINING)\b/;

/**
 * A legal entity rather than a storefront name: a code or a number where a brand would be ("GCC LEVEL LLC",
 * "AMG 770W181 QUICKSERVE", "FORDHAM CJ LLC"). Franchise units file under names like these.
 */
export const entityLike = (dba: string) => normName(dba).split(" ").some((w) => /\d/.test(w) || (/^[A-Z]{2,4}$/.test(w) && !/[AEIOU]/.test(w)));

/**
 * The name a franchisee files under, rather than a storefront brand: an entity code ("GCC LEVEL LLC"), the brand's own
 * word, a "<name> OF <street> AVE" shell ("SHREE SHIV OF FOREST AVE INC"), a person's name ("NISHIT PATEL"), or a legal
 * suffix on nothing but generic and place words ("CREAM NATIONAL CORP"). Only asked when the phone already sits on a
 * chain's inspected stores.
 */
export function franchiseeName(dba: string, brand: string): boolean {
  const n = normName(dba), core = coreTokens(dba).filter((w) => /[A-Z]{3,}/.test(w));
  if (entityLike(dba)) return true;
  const word = brandWord(brand);
  if (word && n.split(" ").includes(word)) return true;
  if (/\bOF \w+ (AVE|AVENUE|ST|STREET|BLVD|BOULEVARD|ROAD|RD|PLACE|PL)\b/.test(n)) return true;
  if (/\b(INC|LLC|CORP|CORPORATION|LTD)\b/i.test(dba) && core.length === 0) return true;
  const t = n.split(" ").filter(Boolean);
  return t.length >= 2 && t.length <= 3 && t.every((w) => /^[A-Z]+$/.test(w) && !GENERIC_TOKENS.has(w) && !PLACE_WORDS.has(w)) && !/\b(INC|LLC|CORP)\b/i.test(dba);
}

/**
 * What the city's inspected records say about each new filing, by address and by building ID:
 * an established place with a fresh permit (the same business, older CAMIS: established, not new);
 * already open (the same business inspected under a NEWER CAMIS: the old application is a leftover);
 * the same operator (same phone line at a single storefront, where the city inspects at most two places);
 * a franchise unit (its phone sits on inspected stores of a chain elsewhere and it files under a franchisee's kind of
 * name: the operator buys centrally). An operator opening its own concept keeps the door, noted;
 * a hotel or venue building (an inspected room service, lobby bar or concession under the same building ID).
 */
export function applyReference(ps: Prospect[], inspected: InspectedPlace[], chains: Map<string, number>): Prospect[] {
  const byAddr = new Map<string, InspectedPlace[]>(), byPhone = new Map<string, InspectedPlace[]>(), byBin = new Map<string, InspectedPlace[]>();
  const push = <K,>(m: Map<K, InspectedPlace[]>, k: K, q: InspectedPlace) => (m.get(k) ?? m.set(k, []).get(k)!).push(q);
  for (const q of inspected) {
    push(byAddr, addressKey(`${q.building} ${q.street}`, q.zip), q);
    const ph = normPhone(q.phone); if (ph) push(byPhone, ph, q);
    const b = realBin(q.bin); if (b) push(byBin, b, q);
  }
  for (const p of ps) {
    const key = addressKey(p.address, p.zip);
    const exclude = addressWords(p.address);
    const atAddr = hasAddress(p.address) ? byAddr.get(key) ?? [] : [];
    const near = [...new Map([...atAddr, ...(p.bin ? byBin.get(p.bin) ?? [] : [])].map((q) => [q.camis, q])).values()]
      .filter((q) => q.camis !== p.camis).sort((a, b) => a.first.localeCompare(b.first));
    const byName = near.find((q) => sameBusiness(p.rawName, q.dba, exclude));
    const tenants = new Set(atAddr.map((q) => q.camis)).size;
    const sameLine = atAddr.filter((q) => q.camis !== p.camis && !!p.phone && normPhone(q.phone) === p.phone).sort((a, b) => a.first.localeCompare(b.first))[0];
    const match = byName ?? (sameLine && tenants <= 2 ? sameLine : undefined);
    if (match) {
      p.repermit = { camis: match.camis, name: titleCase(match.dba), first: match.first, newer: Number(match.camis) > Number(p.camis), byPhone: !byName };
      continue;
    }
    if (sameLine) p.flags.push(`phone carried over from ${titleCase(sameLine.dba)}, one of ${tenants} places the city inspects at this address`);

    if (p.phone && !p.phoneShared && !p.siteKind) {
      const elsewhere = (byPhone.get(p.phone) ?? []).filter((q) => addressKey(`${q.building} ${q.street}`, q.zip) !== key);
      const stores = new Map<string, Set<string>>();
      for (const q of elsewhere) { const n = normName(q.dba); (stores.get(n) ?? stores.set(n, new Set()).get(n)!).add(q.camis); }
      const brand = [...stores].find(([n]) => chains.has(n) && !isGenericName(n));
      const group = brand ? undefined : [...stores].find(([, s]) => s.size >= 3);
      if (brand) {
        const name = titleCase(elsewhere.find((q) => normName(q.dba) === brand[0])!.dba);
        if (franchiseeName(p.rawName, brand[0])) {
          p.franchise = name; p.flags.push(`phone also on ${brand[1].size} inspected ${name} stores`);
        } else {
          p.owner = p.owner ?? `operator of ${name}`;
          p.flags.push(`its operator also runs ${brand[1].size} inspected ${name} stores: its own concept, kept as a door`);
        }
      } else if (group) {
        // A small independent group (three Kinship Coffee stores on one line) is one owner buying per location: a door.
        const name = titleCase(elsewhere.find((q) => normName(q.dba) === group[0])!.dba);
        p.owner = p.owner ?? `operator of ${name}`;
        p.flags.push(`one owner with ${group[1].size} inspected ${name} stores on this phone: kept as a door`);
      }
    }

    if (p.bin) {
      const hit = (byBin.get(p.bin) ?? []).find((q) => BUILDING_KITCHEN.test(normName(q.dba)));
      if (hit) { p.building = titleCase(hit.dba); p.flags.push(`same building as inspected "${p.building}": a hotel, office or venue kitchen`); }
    }
  }
  return ps;
}

export function toProspects(rows: RawRow[], chains: Map<string, number>, recency: RecencyModel, hoods = new Map<string, string>(), inspected: InspectedPlace[] = []): Prospect[] {
  const seen = new Map<string, RawRow>();
  for (const r of rows) if (r.camis) seen.set(r.camis, r);
  const out: Prospect[] = [];
  for (const r of seen.values()) {
    const flags: string[] = [];
    const rawName = cleanText(r.dba);
    const { boro, inferred } = inferBoro(r.boro, r.zipcode);
    if (inferred) flags.push("borough missing in the record, inferred from the ZIP code");
    if (boro === "Unknown") flags.push("borough missing and ZIP unusable");
    let lat = Number(r.latitude), lon = Number(r.longitude);
    if (!(lat >= NYC.latMin && lat <= NYC.latMax && lon >= NYC.lonMin && lon <= NYC.lonMax)) {
      flags.push("no usable map location");
      lat = NaN; lon = NaN;
    }
    const phone = normPhone(r.phone);
    if (!phone) flags.push("no usable phone number in the record");
    else if (!isNycPhone(phone)) flags.push("phone is outside NYC area codes, often a consultant or head office");
    const cs = chainSize(rawName, chains);
    const est = recency.estimate(Number(r.camis));
    out.push({
      camis: r.camis,
      name: titleCase(rawName || "Unnamed"),
      rawName,
      boro,
      address: titleCase(`${String(r.building ?? "").trim()} ${String(r.street ?? "").trim()}`.trim()),
      zip: String(r.zipcode ?? "").trim(),
      phone,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      nta: r.nta ? String(r.nta) : null,
      hood: r.nta ? hoods.get(String(r.nta)) ?? null : null,
      bizType: classify(rawName),
      chain: cs > 0,
      chainLocations: cs,
      peerMonth: est.month,
      freshness: est.freshness,
      newest: est.newest,
      siteSize: 1,
      siteKind: null,
      siteKey: null,
      phoneShared: 0,
      owner: null,
      bin: realBin(r.bin),
      repermit: null,
      franchise: null,
      building: null,
      flags,
    });
  }
  // Sites first, over raw filings; then merge duplicates, which inherit the site tag; then the city's inspected records.
  return applyReference(mergeDuplicateFilings(markSites(out)), inspected, chains);
}
