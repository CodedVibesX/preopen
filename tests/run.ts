// preopen tests: unit checks per module, then invariants on the committed snapshot. No framework: run with `npm test`.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normPhone, titleCase, classify, chainSize, buildChains, inferBoro, mergeDuplicateFilings, markSites, applyReference,
  addressKey, addressWords, cleanText, displayName, toProspects, isSeasonal, isParkConcession, isNycPhone, isGenericName, entityLike, franchiseeName, sameBusiness, SITE_MIN,
} from "../src/clean.ts";
import { normName, loadSnapshot, loadFirstInspections, loadInspected, loadNtaNames, nyMonth, type InspectedPlace } from "../src/data.ts";
import { buildRecency, monthsBetween, rankCorrelation } from "../src/recency.ts";
import { score, SCORE_CEIL, SCORE_FLOOR } from "../src/score.ts";
import { buildRoutes, twoOpt, pathKm, hoursFor, dayValue, ROUTE_LIMITS } from "../src/route.ts";
import { csvRow, hubspotCsv, HUBSPOT_HEADER, routeStops, safeText, skippedCsv } from "../src/export.ts";
import { parseCsv, wilson, readWalk, walkTemplate, WALK_HEADER } from "../src/walk.ts";
import { diffSnapshots } from "../src/diff.ts";
import { pipeline, newDoors, summarize, siteList, departureFate } from "../src/cli.ts";
import type { Prospect, RawRow, Scored, Snapshot } from "../src/types.ts";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`); }
}
function eq<T>(got: T, want: T, what = "") {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function ok(cond: unknown, what: string) { if (!cond) throw new Error(what); }
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

/** A clean prospect; every fixture gets its own phone so the same phone merge only fires when a test asks for it. */
function prospect(over: Partial<Prospect> = {}): Prospect {
  const camis = over.camis ?? "50190000";
  return {
    camis, name: "Test Kitchen", rawName: "TEST KITCHEN", boro: "Brooklyn", address: "1 Kent Avenue", zip: "11249",
    phone: `+1718${camis.slice(-7)}`, lat: 40.715, lon: -73.965, nta: "BK73", hood: "North Side, South Side", bizType: "restaurant",
    chain: false, chainLocations: 0, peerMonth: "2026-10", freshness: "on_track", newest: false,
    siteSize: 1, siteKind: null, siteKey: null, phoneShared: 0, owner: null, bin: null, repermit: null, franchise: null, building: null,
    flags: [], ...over,
  };
}
/** An inspected place for the reference based rules. */
function place(over: Partial<InspectedPlace> = {}): InspectedPlace {
  return { camis: "40000001", dba: "OLD PLACE", building: "1", street: "KENT AVENUE", zip: "11249", phone: "", bin: "", first: "2023-01-31", last: "2026-06-01", permitType: null, ...over };
}
const M_LAT = 1 / 111320, M_LON = 1 / (111320 * Math.cos(40.7 * (Math.PI / 180)));

const DAY = 86400000;
const synth = (month: string, base: number) => Array.from({ length: 40 }, (_, i) => ({ camis: base + i, first: Date.parse(`${month}-15T00:00:00Z`) + (i % 5) * DAY }));
const model = buildRecency([...synth("2025-01", 1000), ...synth("2025-06", 2000), ...synth("2026-01", 3000), ...synth("2026-09", 4000)], "2026-10", "2024-01");

console.log("clean");
test("phone: ten digits to E.164, junk to null, NYC area codes known", () => {
  eq(normPhone("7185550123"), null, "555 exchange");
  eq(normPhone("(347) 749-9915"), "+13477499915");
  eq(normPhone("13477499915"), "+13477499915", "leading country code");
  eq(normPhone("0000000000"), null, "repeated digit");
  eq(normPhone("2125"), null, "short");
  eq(normPhone("1234567890"), null, "area code cannot start with 1");
  eq(normPhone(undefined), null);
  eq([isNycPhone("+12125550100"), isNycPhone("+19295550100"), isNycPhone("+17045550100"), isNycPhone("+18665550100"), isNycPhone(null)], [true, true, false, false, false]);
});
test("names: title case keeps apostrophes and accents, fixes L' and O' names and acronyms, drops the legal suffix for display", () => {
  eq(titleCase("BARRY'S WALL STREET"), "Barry's Wall Street");
  eq(titleCase("POP’S PIZZA"), "Pop’s Pizza");
  eq(titleCase("DÄN BAKERY & CAFÉ"), "Dän Bakery & Café");
  eq(titleCase("L'ARTUSI"), "L'Artusi");
  eq(titleCase("O'NEILL'S PUB"), "O'Neill's Pub");
  eq(titleCase("90 SOUTH    4 STREET"), "90 South 4 Street");
  eq(titleCase("C BURGER NY INC."), "C Burger NY INC.");
  eq(titleCase("JFK T4 F&B II LLC"), "JFK T4 F&B II LLC");
  eq(displayName("Happy Seafood Restaurant INC"), "Happy Seafood Restaurant");
  eq(displayName("8 Avenue Chun Yang Tea, INC."), "8 Avenue Chun Yang Tea");
  eq(displayName("LLC"), "LLC", "never empties a name");
});
test("control characters from an upstream encoding slip never reach a name", () => {
  eq(cleanText("M\u001aZIC"), "MZIC");
  eq(cleanText("  TWO \t SPACES\n"), "TWO SPACES");
});
test("normName strips accents and filler but keeps a brand's '& CO'", () => {
  eq(normName("HEYTEA USA(NY) LLC"), "HEYTEA");
  eq(normName("STUART CINEMA & CAFÉ"), "STUART CINEMA AND CAFE");
  eq(normName("FRESH & CO"), "FRESH AND CO");
  eq(normName("ACME CO"), "ACME");
});
test("classify: specific types win; institutional, corporate, hotel, airport and venue kitchens; owner run caterers stay", () => {
  eq(classify("JUICE BAR & GRILL"), "juice");
  eq(classify("ICE CREAM BAR"), "dessert");
  eq(classify("BAR SARDINE"), "bar");
  eq(classify("STUART CINEMA & CAFÉ"), "cafe");
  eq(classify("JOE'S PIZZA"), "pizza");
  eq(classify("BIANG BIANG NOODLE"), "fast_casual");
  eq(classify("MY FRIEND DUKE"), "restaurant");
  for (const n of ["PS 123 SCHOOL CAFETERIA", "ARAMARK SERVICES INC", "RA @ AMAZON JFK25 COFFEE", "OPENAI NYC CAFE 5TH FL",
    "HILTON GARDEN INN", "NEW YORK THEATRE WORKSHOP", "NOM WAH RESTAURANT (GATE 525)", "MEMBERS RESTAURANT AT THE TWENTY TWO",
    "CHICKEN/FRIES CONCESSION", "MAIN DINING HALL", "CCNY CAMPUS EATS", "245 PARK AMENITY LLC", "BROADWAY FOOD COURT",
    "LEVY AT JAVITS CENTER", "BETANCES HEALTH CENTER", "NEW YORK ATHLETIC CLUB"])
    eq(classify(n), "institutional", n);
  for (const [n, t] of [["LEONS CHURCH LLC", "restaurant"], ["5TH FLOOR BAR / HABIBTI BAR", "bar"], ["FLOOR 2", "restaurant"],
    ["THE MUSEUM BAR", "bar"], ["WOODBINE CATERERS INC", "restaurant"], ["WYNN CATERING HALL", "restaurant"]] as const)
    eq(classify(n), t, `${n} is not institutional`);
});
test("seasonal kiosks by name or address, without catching Santa Fe or PopUp Bagels; park concessions by address", () => {
  eq([isSeasonal("SANTA CLAUS WORK SHOP /POFFERTJETS"), isSeasonal("CHRISTMAS IN NEW YORK"), isSeasonal("SANTA FE GRILL"), isSeasonal("POPUP BAGELS")], [true, true, false, false]);
  eq(isSeasonal("BESSOU SNACKSHOP", "000 Bryant Park Winter Village"), true);
  eq([isParkConcession("171 East Drive", "11225"), isParkConcession("106-51 East Drive", "10000"), isParkConcession("10 West End Avenue", "10023")], [true, true, false]);
});
test("chain match: exact, prefix with more words, no short prefixes, never a generic shared name", () => {
  const chains = new Map([["NAYA", 28], ["KFC", 40], ["CHIPOTLE MEXICAN GRILL", 72], ["FRESH AND CO", 10], ["CHINA KING", 40], ["BURGER KING", 50], ["KENNEDY FRIED CHICKEN", 78]]);
  eq(chainSize("NAYA", chains), 28);
  eq(chainSize("NAYA PARK SLOPE LLC", chains), 28);
  eq(chainSize("CHIPOTLE MEXICAN GRILL #5776", chains), 72);
  eq(chainSize("KFC EXPRESS", chains), 0, "3 letter names only match exactly");
  eq(chainSize("NAYAB HALAL", chains), 0, "prefix must end on a word boundary");
  eq(chainSize("FRESH & CO", chains), 10);
  eq(chainSize("FRESH & TASTY DELI", chains), 0, "'& CO' is not filler");
  eq(chainSize("CHINA KING", chains), 0, "40 unrelated owners share that name");
  eq(chainSize("KENNEDY FRIED CHICKEN & PIZZA", chains), 0, "78 permits, 68 phone numbers: a shared name");
  eq(chainSize("BURGER KING", chains), 50);
  eq([isGenericName("GREAT WALL"), isGenericName("1 50 FRESH PIZZA"), isGenericName("CRISPY BURGER"), isGenericName("PIZZA HUT"), isGenericName("BURGER KING")], [true, true, true, false, false]);
});
test("chains count inspected stores plus today's filings at distinct addresses, so a chain entering NYC is caught", () => {
  const inspected = [1, 2, 3].map((i) => place({ camis: String(40000000 + i), dba: "CRUMBL", building: String(10 * i) }));
  const rows: RawRow[] = [["5", "MAIN STREET"], ["9", "OAK STREET"], ["9", "OAK ST"]].map(([b, s], i) => ({ camis: String(50100000 + i), dba: "CRUMBL", building: b, street: s, zipcode: "11201" }));
  eq(buildChains(inspected, rows).get("CRUMBL"), 5, "3 inspected + 2 distinct new addresses (the third filing repeats one)");
  eq(buildChains(inspected.slice(0, 2), rows).has("CRUMBL"), false, "4 locations is not a chain");
});
test("borough inferred from ZIP when the record says 0", () => {
  eq(inferBoro("0", "11249"), { boro: "Brooklyn", inferred: true });
  eq(inferBoro("0", "10032"), { boro: "Manhattan", inferred: true });
  eq(inferBoro("Queens", "11101"), { boro: "Queens", inferred: false });
  eq(inferBoro("0", ""), { boro: "Unknown", inferred: false });
});
test("address key: one place however it is spelled; ordinals never read as ROAD; St Marks keeps its house number", () => {
  eq(addressKey("42w 42nd St", "10036"), addressKey("42 West 42 Street", "10036"));
  eq(addressKey("110a Mulberry St", "10013"), addressKey("110A Mulberry Street", "10013"));
  eq(addressKey("000 Bryant Park", "10036"), "BRYANT PARK|10036");
  eq(addressKey("301 3rd Ave", "10003"), addressKey("301 3 Avenue", "10003"));
  ok(!addressKey("301 3rd Ave", "10003").includes("ROAD"), "3rd is not 3 ROAD");
  eq(addressKey("1 St Marks Pl", "10003"), "1 STREET MARKS PLACE|10003");
  ok(addressKey("42 West 42 Street", "10036") !== addressKey("42 West 42 Street", "10018"), "ZIP is part of the key");
});
test("same business: identical names, or one name's identifying words inside the other's; generic words never decide", () => {
  eq(sameBusiness("PADEL HAUS", "PADEL HAUS WILLIAMSBURG LLC"), true);
  eq(sameBusiness("98K CHICKEN&BURGER", "98K"), true);
  eq(sameBusiness("8 AVENUE CHUN YANG TEA, INC.", "CHUN YANG TEA"), true);
  eq(sameBusiness("TACO STAND", "RAMEN STAND"), false);
  eq(sameBusiness("SUSHI OMAKASE", "OMAKASE ROOM"), false);
  eq(sameBusiness("PHO 88", "PHO VIET"), false);
});
test("duplicate filings merge on business name or same phone; neighbors with their own phones do not; N/A addresses never merge", () => {
  const out = mergeDuplicateFilings([
    prospect({ camis: "50100001", rawName: "PADEL HAUS", name: "Padel Haus", address: "307 Kent Avenue" }),
    prospect({ camis: "50100002", rawName: "PADEL HAUS WILLIAMSBURG LLC", name: "Padel Haus Williamsburg LLC", address: "307 Kent Ave", phone: null }),
    prospect({ camis: "50100003", rawName: "HAPPY SEAFOOD RESTAURANT INC", address: "816 58 Street", phone: "+17185550199" }),
    prospect({ camis: "50100004", rawName: "YUEHAI RESTAURANT INC", address: "816 58 Street", phone: "+17185550199" }),
    prospect({ camis: "50100005", rawName: "TACO STAND", address: "1 Food Hall Way" }),
    prospect({ camis: "50100006", rawName: "RAMEN STAND", address: "1 Food Hall Way" }),
    prospect({ camis: "50100007", rawName: "SAME NAME", address: "N/A N/A", lat: 40.60, lon: -73.90 }),
    prospect({ camis: "50100008", rawName: "SAME NAME", address: "N/A N/A", lat: 40.80, lon: -73.95 }),
  ]);
  eq(out.length, 6);
  const padel = out.find((p) => p.rawName.startsWith("PADEL"))!;
  eq(padel.camis, "50100002", "keeps the newest filing");
  eq(padel.phone, "+17180100001", "keeps the phone only the older filing had");
  ok(padel.flags.some((f) => f.includes("50100001")), "records the merged CAMIS");
  eq(out.filter((p) => p.address === "816 58 Street").length, 1, "same address and same phone is one place");
});
test("a merged twin inherits the expediter flag with the phone, and an institutional type", () => {
  const out = mergeDuplicateFilings([
    prospect({ camis: "50110001", rawName: "CORNER CAFE", address: "5 Main Street", phone: "+19295550111", phoneShared: 4 }),
    prospect({ camis: "50110002", rawName: "CORNER CAFE NYC LLC", address: "5 Main Street", phone: null }),
    prospect({ camis: "50110003", rawName: "RA AMAZON CAFE", address: "9 Main Street", bizType: "institutional" }),
    prospect({ camis: "50110004", rawName: "AMAZON CAFE", address: "9 Main Street" }),
  ]);
  const cafe = out.find((p) => p.camis === "50110002")!;
  eq([cafe.phone, cafe.phoneShared], ["+19295550111", 4]);
  eq(out.find((p) => p.camis === "50110004")!.bizType, "institutional");
});
test("the real cleaning path marks sites before merging duplicates (the 41 W 40 St leak)", () => {
  const rows = ["BIANG BIANG NOODLE", "CHUBBY TACO", "DISCO NUTS NYC", "DISCO NUTS NYC"].map((dba, i) => ({
    camis: String(50210000 + i), dba, boro: "Manhattan", building: "41", street: i % 2 ? "WEST 40 STREET" : "W 40TH ST", zipcode: "10018",
    phone: `212${String(4100000 + i)}`, latitude: String(40.7527 + i * 0.0003), longitude: "-73.9832", inspection_date: "1900-01-01T00:00:00.000",
  }));
  const out = toProspects(rows, new Map(), model);
  eq(out.length, 3);
  ok(out.every((p) => p.siteKind === "address" && p.siteSize === SITE_MIN), `site kinds: ${out.map((p) => `${p.siteKind}/${p.siteSize}`).join(",")}`);
  eq(score(out[0]).qualified, false);
  ok(score(out[0]).reasons[0].includes("sites list"), "the skip reason names the sites list");
});
test("sites: 5+ filings in one building are a site; a busy block, or storefronts each in their own building, are not", () => {
  const spot = Array.from({ length: 5 }, (_, i) => prospect({ camis: String(50300000 + i), rawName: `KIOSK ${i}`, address: `${40 + i} Bryant Park`, lat: 40.75407 + i * 0.5 * M_LAT, lon: -73.98232 }));
  eq(markSites(spot).filter((p) => p.siteKind === "cluster").length, 5);
  const block = Array.from({ length: 6 }, (_, i) => prospect({ camis: String(50310000 + i), rawName: `SHOP ${i}`, address: `${344 + 2 * i} West 46 Street`, lat: 40.76034, lon: -73.98925 + i * 8 * M_LON }));
  eq(markSites(block).filter((p) => p.siteKind).length, 0, "storefronts 8 m apart");
  const steinway = Array.from({ length: 6 }, (_, i) => prospect({ camis: String(50320000 + i), rawName: `SPOT ${i}`, address: `25-${10 + i} Steinway Street`, lat: 40.7652, lon: -73.9123 + i * 0.5 * M_LON, bin: String(4010280 + i) }));
  eq(markSites(steinway).filter((p) => p.siteKind).length, 0, "one geocode point, six real buildings");
  const fourBuildings = Array.from({ length: 8 }, (_, i) => prospect({ camis: String(50325000 + i), rawName: `SPOT ${i}`, address: `25-${20 + i} Steinway Street`, lat: 40.7652, lon: -73.9123 + i * 0.3 * M_LON, bin: String(4011000 + Math.floor(i / 2)) }));
  eq(markSites(fourBuildings).filter((p) => p.siteKind).length, 0, "a point spanning four real buildings is a block, even with two filings in each");
  const four = Array.from({ length: 4 }, (_, i) => prospect({ camis: String(50330000 + i), rawName: `KIOSK ${i}`, address: `${50 + i} Bryant Park`, lat: 40.754, lon: -73.982 }));
  eq(markSites(four).filter((p) => p.siteKind).length, 0, "4 at one spot is under the cluster threshold");
});
test("sites never double count: a phone line spanning two markets does not glue them into one site", () => {
  const market = (street: string, base: number, lat: number) => Array.from({ length: 4 }, (_, i) =>
    prospect({ camis: String(base + i), rawName: `VENDOR ${base + i}`, address: `20 ${street}`, zip: "10003", lat, lon: -73.99 + i * 0.001, phone: i === 0 ? "+17045550123" : `+1718${base + i}`.slice(0, 12) }));
  const loner = prospect({ camis: "50349999", rawName: "THIRD TOWER CAFE", address: "9 Wall Street", zip: "10005", lat: 40.70, lon: -74.01, phone: "+17045550123" });
  const ps = markSites([...market("Union Square West", 50340000, 40.73), ...market("Columbus Circle", 50341000, 40.77), loner]);
  const sites = siteList(ps.map((p) => score(p)));
  eq(sites.map((s) => s.filings).sort(), [1, 4, 4], "two markets of 4, and the line keeps only the filing no market claimed");
  eq(sites.reduce((a, s) => a + s.filings, 0), ps.filter((p) => p.siteKind).length, "site filings sum to distinct filings");
});
test("phone lines: out of town on 3+ addresses is a site; NYC on 3+ is an owner group when names share a brand, else an expediter", () => {
  const line = (phone: string, names: string[], base: number) => names.map((n, i) =>
    prospect({ camis: String(base + i), rawName: n, address: `${10 + 7 * i} Broadway`, lat: 40.7 + i * 0.01, phone }));
  const caterer = markSites(line("+17043286780", ["DATADOG", "BLACKROCK", "LINKEDIN"], 50400000));
  ok(caterer.every((p) => p.siteKind === "phone"), "Charlotte caterer line");
  eq(score(caterer[0]).qualified, false);
  const expediter = markSites(line("+19295550111", ["WILLIAMSBURG DINER", "LUMEN RESTAURANT", "J&M MEXICAN GRILL"], 50410000));
  ok(expediter.every((p) => p.siteKind === null && p.phoneShared === 3 && !p.owner), "expediter: doors stay, phone flagged");
  eq(score(expediter[0]).qualified, true);
  ok(!score(expediter[0]).reasons.some((r) => r.includes("call ahead")), "no call ahead credit for an expediter's line");
  const owner = markSites(line("+16465550133", ["HUDSON CABIN", "HUDSON CABIN UES", "MUNCHY MUNCHY"], 50420000));
  ok(owner.every((p) => p.siteKind === null && p.phoneShared === 0 && p.owner === "Hudson Cabin"), `owner group: ${owner.map((p) => p.owner).join(",")}`);
  ok(markSites(line("+17045550122", ["A PLACE", "B PLACE"], 50430000)).every((p) => !p.siteKind && !p.phoneShared), "two addresses is one owner");
});

console.log("the city's inspected records");
test("an established place with a fresh permit is skipped; a new owner with its own phone at an old address is not", () => {
  const ref = [place({ camis: "40395079", dba: "RUDY'S BAR & GRILL", building: "627", street: "9 AVENUE", zip: "10036", phone: "2129999999" })];
  const [rudys, newOwner, sameLine] = applyReference([
    prospect({ camis: "50192805", rawName: "RUDYS BAR AND GRILL", address: "627 9 Avenue", zip: "10036" }),
    prospect({ camis: "50192806", rawName: "BRAND NEW TAQUERIA", address: "627 9 Avenue", zip: "10036" }),
    prospect({ camis: "50192807", rawName: "ANOTHER NEW SPOT", address: "627 9 Avenue", zip: "10036", phone: "+12129999999" }),
  ], ref, new Map());
  eq([rudys.repermit?.camis, rudys.repermit?.newer, rudys.repermit?.byPhone], ["40395079", false, false]);
  eq(score(rudys).qualified, false);
  ok(score(rudys).reasons[0].includes("established place with a fresh permit"), "the reason says why");
  eq([newOwner.repermit, score(newOwner).qualified], [null, true]);
  eq([sameLine.repermit?.byPhone, score(sameLine).qualified], [true, false], "same line at a single storefront is the same operator");
});
test("a phone carried over inside a food hall is only noted; a newer inspected permit means already open; building IDs bridge address spellings", () => {
  const hall = [1, 2, 3].map((i) => place({ camis: String(40500000 + i), dba: `STALL ${i}`, building: "75", street: "9 AVENUE", zip: "10011", phone: i === 1 ? "2129870199" : "" }));
  const [tenant] = applyReference([prospect({ camis: "50193001", rawName: "THE TIPPLER", address: "75 9 Avenue", zip: "10011", phone: "+12129870199" })], hall, new Map());
  eq([tenant.repermit, score(tenant).qualified], [null, true]);
  ok(tenant.flags.some((f) => f.startsWith("phone carried over")) && !score(tenant).reasons.some((r) => r.includes("call ahead")), "noted, and no call ahead credit");
  const [motek] = applyReference([prospect({ camis: "50184278", rawName: "MOTEK", address: "184 Bleecker Street", zip: "10012" })],
    [place({ camis: "50185342", dba: "MOTEK", building: "184", street: "BLEECKER STREET", zip: "10012", first: "2026-04-29" })], new Map());
  eq([motek.repermit?.newer, score(motek).qualified], [true, false]);
  ok(score(motek).reasons[0].startsWith("skip: already open"), "already open is its own reason");
  const [knot] = applyReference([prospect({ camis: "50190001", rawName: "DOUBLE KNOT", address: "1251 6 Avenue", zip: "10020", bin: "1085000" })],
    [place({ camis: "50150001", dba: "DOUBLE KNOT", building: "1251", street: "AVENUE OF THE AMERICAS", zip: "10020", bin: "1085000" })], new Map());
  eq(knot.repermit?.camis, "50150001", "same building ID, different spelling of the address");
});
test("place, street and cuisine words never make two names match; near identical names do", () => {
  for (const [a, b] of [["TOP POT STATEN ISLAND INC", "POKE ISLAND GRILL"], ["TACO MIX BRONX TERMINAL INC", "BRONX BURGER CO"],
    ["CARIBBEAN SIBLINGS CUISINE LLC", "BEST CARIBBEAN RESTAURANT & GRILL"], ["THA SOUL SPOT", "THE NEW SOUL CAFE"], ["TRUE NORTH TRIBECA", "NORTH BAR"]])
    eq(sameBusiness(a, b), false, `${a} vs ${b}`);
  eq(sameBusiness("148 NOBLE STREET", "THE NOBLE", addressWords("148 Noble Street")), false, "the street name is not the business");
  for (const [a, b] of [["ROYAL SEAFOOD", "ROYAL SEAFOOD CAFE"], ["BRICKSTOWN BAGELS & CAFE", "BRICKTOWN BAGELS & CAFE"], ["AVENUE D PIZZERIA", "AVE D PIZZERIA"],
    ["CHEN'S RESTAURANT CHINA KING INC.", "CHINA KING"], ["NUEVO RINCO DEL SABOR 2 RESTAURANT CORP", "NUEVO RINCON DEL SABOR"], ["NO 2 FAVOR TASTE INC.", "NO.1 FAVOR TASTE RESTAURANT"]])
    eq(sameBusiness(a, b), true, `${a} vs ${b}`);
});
test("a franchise unit filed under an entity name is skipped; the same operator's own concept stays, noted", () => {
  const dunkin = [1, 2, 3, 4, 5].map((i) => place({ camis: String(40100000 + i), dba: "DUNKIN", building: String(100 + i), street: "BROADWAY", phone: "9170000001" }));
  const chains = new Map([["DUNKIN", 444]]);
  const [unit, concept] = applyReference([
    prospect({ camis: "50190717", rawName: "GCC LEVEL LLC", phone: "+19170000001" }),
    prospect({ camis: "50190718", rawName: "MYTHOS", address: "9 Kent Avenue", phone: "+19170000001" }),
  ], dunkin, chains);
  eq([unit.franchise, score(unit).qualified], ["Dunkin", false]);
  eq([concept.franchise, concept.owner, score(concept).qualified], [null, "operator of Dunkin", true]);
  eq([entityLike("GCC LEVEL LLC"), entityLike("AMG 770W181 QUICKSERVE LLC"), entityLike("FORDHAM CJ LLC"), entityLike("MYTHOS"), entityLike("SANTO TACO")], [true, true, true, false, false]);
  for (const n of ["SHREE SHIV OF FOREST AVE INC", "NISHIT PATEL", "CREAM NATIONAL CORP."]) eq(franchiseeName(n, "DUNKIN"), true, n);
  for (const n of ["MYTHOS", "SANTO TACO", "GREAT SHANGHAI PAN-FRIED BAO"]) eq(franchiseeName(n, "DUNKIN"), false, n);
});
test("three stores of a small independent on one line make an owner group, not a franchise; a shared generic name never does", () => {
  const kinship = [1, 2, 3].map((i) => place({ camis: String(40200000 + i), dba: "KINSHIP COFFEE ROASTERS", building: String(10 + i), street: "SOUTH STREET", phone: "6465122106" }));
  const [unit] = applyReference([prospect({ camis: "50175151", rawName: "32-14 KINSHIP COFFEE INC.", address: "106 South Street", zip: "10038", phone: "+16465122106" })], kinship, new Map());
  eq([unit.franchise, unit.owner, score(unit).qualified], [null, "operator of Kinship Coffee Roasters", true]);
  eq([isGenericName("375 CHICKEN N FRIES"), isGenericName("1 50 FRESH PIZZA")], [false, true], "a three digit number is a brand");
});
test("chains do not count a fresh permit at a known location as a new location", () => {
  const inspected = [1, 2, 3, 4].map((i) => place({ camis: String(40300000 + i), dba: "SOBOL", building: String(10 * i), street: "MAIN STREET", zip: "11201" }));
  const rows: RawRow[] = [{ camis: "50110001", dba: "SOBOL", building: "10", street: "MAIN STREET", zipcode: "11201" }];
  eq(buildChains(inspected, rows).has("SOBOL"), false, "4 locations, the refiling is one of them");
});
test("a corner storefront filed under both of its addresses is one door; the same name across town is not", () => {
  const out = mergeDuplicateFilings([
    prospect({ camis: "50120001", rawName: "ECHO LAKE", address: "58 Marcy Avenue", lat: 40.71, lon: -73.957 }),
    prospect({ camis: "50120002", rawName: "ECHO LAKE", address: "357 Grand Street", lat: 40.7101, lon: -73.9571 }),
    prospect({ camis: "50120003", rawName: "ECHO LAKE", address: "9 Far Street", lat: 40.75, lon: -73.99 }),
  ]);
  eq(out.map((p) => p.camis).sort(), ["50120002", "50120003"]);
});
test("types and neighborhoods read the way a rep would say them", () => {
  eq([classify("AMERICAN JOY BILLIARDS"), classify("CONALL'S PUBLIC HOUSE")], ["bar", "bar"]);
  eq([loadNtaNames().get("BK73"), loadNtaNames().get("MN15")], ["Williamsburg", "Hell's Kitchen"]);
});
test("a departure is read by the CAMIS that left: its own inspection, the same business under another permit, or nothing", () => {
  const row: RawRow = { camis: "50170001", dba: "MOTEK", building: "184", street: "BLEECKER STREET", zipcode: "10012" };
  ok(departureFate(row, { date: "2026-10-20", type: "Pre-permit (Operational) / Initial Inspection" }, []).startsWith("first inspection 2026-10-20, operating"), "own");
  ok(departureFate(row, undefined, [place({ camis: "50185342", dba: "MOTEK", building: "184", street: "BLEECKER STREET", zip: "10012", first: "2026-04-29" })]).startsWith("opened under another permit: CAMIS 50185342"), "twin");
  ok(departureFate(row, undefined, []).startsWith("no inspection on record"), "lapsed");
});
test("a hotel or venue building marks its new permits; an office tower's cafeteria does not", () => {
  const ref = [place({ camis: "41000001", dba: "EMPLOYEE DINING/ROOM SERVICE", bin: "1035000" }), place({ camis: "41000002", dba: "AMAZON CAFETERIA", bin: "1090000" })];
  const [hotel, tower] = applyReference([prospect({ camis: "50195001", rawName: "JAZZ CLUB", bin: "1035000" }), prospect({ camis: "50195002", rawName: "BKLYN LARDER", bin: "1090000" })], ref, new Map());
  eq([hotel.building, score(hotel).qualified], ["Employee Dining/Room Service", false]);
  eq([tower.building, score(tower).qualified], [null, true]);
});

console.log("recency and dates");
test("table is ascending and monotone", () => {
  eq(model.table.map((r) => r.month), ["2025-01", "2025-06", "2026-01", "2026-09"]);
  ok(model.table.every((r, i, a) => i === 0 || r.median >= a[i - 1].median), "running max");
});
test("estimates: through the table, above it, below it", () => {
  eq(model.estimate(4020), { month: "2026-09", freshness: "on_track", newest: false }, "inside the table");
  eq(model.estimate(5000), { month: "2026-10", freshness: "on_track", newest: true }, "above every inspected CAMIS");
  eq(model.estimate(3030).freshness, "behind");
  eq(model.estimate(2030).freshness, "stalled");
  eq(model.estimate(10), { month: "before 2025-01", freshness: "stalled", newest: false });
});
test("freshness boundaries: 3 months on track, 4 behind, 12 behind, 13 old", () => {
  const m = buildRecency([...synth("2025-09", 1000), ...synth("2025-10", 2000), ...synth("2026-06", 3000), ...synth("2026-07", 4000)], "2026-10", "2024-01");
  eq([m.estimate(4020).freshness, m.estimate(3020).freshness, m.estimate(2020).freshness, m.estimate(1020).freshness], ["on_track", "behind", "behind", "stalled"]);
  eq(monthsBetween("2025-11", "2026-02"), 3);
});
test("rank correlation is +1 for permits issued in order and -1 for the reverse", () => {
  const up = Array.from({ length: 20 }, (_, i) => ({ camis: 50100000 + i, first: i * DAY }));
  eq(rankCorrelation(up).rho, 1);
  ok(near(rankCorrelation(up.map((r, i) => ({ ...r, first: -i * DAY }))).rho, -1), "reversed");
  eq(rankCorrelation(up, 60000000).n, 0, "the scope filter applies");
});
test("the recency model is the same in every timezone", () => {
  const was = process.env.TZ;
  const table = (tz: string) => { process.env.TZ = tz; return JSON.stringify(buildRecency(loadFirstInspections(), "2026-10").table); };
  try { eq(table("Asia/Tokyo"), table("America/Los_Angeles")); eq(table("Europe/Berlin"), table("UTC")); }
  finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});
test("the snapshot month is New York's month", () => {
  eq(nyMonth("2026-11-01T03:30:00Z"), "2026-10", "11:30 pm ET on Oct 31");
  eq(nyMonth("2026-10-14T03:53:19.000Z"), "2026-10");
});

console.log("score");
test("the score formula is capped, and even the best possible door stays inside the cap", () => {
  ok(SCORE_CEIL < 1 && SCORE_FLOOR > 0, "cap leaves room for doubt");
  for (const bizType of ["restaurant", "pizza", "juice", "institutional"] as const)
    for (const freshness of ["on_track", "behind", "stalled"] as const)
      for (const newest of [true, false]) {
        const s = score(prospect({ bizType, freshness, newest })).score;
        ok(s >= SCORE_FLOOR && s <= SCORE_CEIL, `${bizType}/${freshness}: ${s}`);
      }
});
test("disqualifiers are explained, not silent", () => {
  const chain = score(prospect({ chain: true, chainLocations: 172 }));
  eq(chain.qualified, false);
  ok(chain.reasons.every((r) => r.startsWith("skip:")) && chain.reasons[0].includes("172"), "skip reason names the chain size");
  eq(score(prospect({ freshness: "stalled" })).qualified, false);
  ok(score(prospect({ freshness: "stalled" })).reasons[0].includes("not because") || score(prospect({ freshness: "stalled" })).reasons[0].includes("not new"), "old means not new, not dead");
  eq(score(prospect({ lat: null, lon: null })).qualified, false);
  eq(score(prospect({ bizType: "institutional" })).qualified, false);
  eq(score(prospect({ rawName: "CHRISTMAS IN NEW YORK" })).qualified, false);
  eq(score(prospect({ address: "171 East Drive", zip: "11225" })).qualified, false);
  eq(score(prospect()).qualified, true);
});
test("a better fit outranks a worse one, all else equal", () => {
  ok(score(prospect({ bizType: "pizza" })).score > score(prospect({ bizType: "juice" })).score, "pizza over juice");
  ok(score(prospect()).score > score(prospect({ freshness: "behind" })).score, "on track over behind");
  ok(score(prospect({ newest: true })).score > score(prospect()).score, "newest bonus");
  ok(score(prospect()).score > score(prospect({ phone: "+17045550100" })).score, "an out of town phone earns no call ahead credit");
});

console.log("route");
const grid = (n: number, lat0 = 40.7, lon0 = -73.95, base = 50000000): Scored[] =>
  Array.from({ length: n }, (_, i) => score(prospect({ camis: String(base + i), lat: lat0 + (i % 7) * 0.0012, lon: lon0 + Math.floor(i / 7) * 0.0015 })));
test("2 opt never lengthens a path", () => {
  const pts = grid(30).sort((a, b) => (Number(a.camis) * 7919) % 31 - (Number(b.camis) * 7919) % 31);
  ok(pathKm(twoOpt(pts)) <= pathKm(pts) + 1e-9, "2 opt made it longer");
});
test("2 opt may move the first and last stop", () => {
  const at = (km: number, i: number) => score(prospect({ camis: String(50500000 + i), lat: 40.7, lon: -73.95 + km * 1000 * M_LON }));
  const best = 4.2 * ROUTE_LIMITS.gridFactor;
  const endMoves = [at(0, 0), at(4.2, 1), at(0.08, 2)];
  ok(near(pathKm(twoOpt(endMoves)), best, 0.01), `end must move: got ${pathKm(twoOpt(endMoves))} km`);
  const startMoves = [at(0.08, 3), at(4.2, 4), at(0, 5)];
  ok(near(pathKm(twoOpt(startMoves)), best, 0.01), `start must move: got ${pathKm(twoOpt(startMoves))} km`);
});
test("a day grows from either end, so a dead end on one side does not strand the doors", () => {
  const pair = (km: number, base: number) => [0, 1].map((j) => score(prospect({ camis: String(base + j), lat: 40.7 + j * 20 * M_LAT, lon: -73.95 + km * 1000 * M_LON })));
  const { routes, unrouted } = buildRoutes([...pair(0, 50600000), ...pair(-1, 50600010), ...pair(1, 50600020)]);
  eq([routes.length, routes[0]?.stops.length, unrouted.length], [1, 6, 0]);
});
test("every qualified door lands on exactly one route or the call list", () => {
  const pts = [...grid(60), ...grid(3, 40.6, -73.8, 51000000)];
  const { routes, unrouted } = buildRoutes(pts);
  const ids = [...routes.flatMap((r) => r.stops.map((s) => s.camis)), ...unrouted.map((s) => s.camis)];
  eq(ids.length, pts.length);
  eq(new Set(ids).size, pts.length);
  eq(unrouted.length, 3, "a 3 door cluster is too small for a day");
});
test("each day respects the stop and hour caps, and days are ranked by score per hour", () => {
  const { routes } = buildRoutes(grid(120));
  ok(routes.length >= 5, `expected several days, got ${routes.length}`);
  for (const r of routes) {
    ok(r.stops.length <= ROUTE_LIMITS.maxStops && r.stops.length >= ROUTE_LIMITS.minStops, `${r.id} has ${r.stops.length} stops`);
    ok(r.hours <= ROUTE_LIMITS.maxHours, `${r.id} takes ${r.hours} h`);
    ok(near(r.hours, hoursFor(r.stops), 0.01), "hours match the stop order");
    eq(r.stops.map((s) => s.order), r.stops.map((_, i) => i + 1), `${r.id} order`);
  }
  ok(routes.every((r, i) => i === 0 || dayValue(routes[i - 1]) >= dayValue(r)), "ranked best first");
});
test("a full day outranks a short day of the same density: reaching the first door costs time", () => {
  const full = buildRoutes(grid(25)).routes[0], short = buildRoutes(grid(6, 40.6, -73.8, 52000000)).routes[0];
  ok(full && short && dayValue(full) > dayValue(short), "a six door day must not outrank a full one");
});
test("Google Maps legs carry at most 3 waypoints (the phone browser limit) and connect end to end", () => {
  const { routes } = buildRoutes(grid(25));
  const links = routes[0].mapsLinks.map((u) => new URL(u));
  for (const u of links) ok((u.searchParams.get("waypoints")?.split("|").length ?? 0) <= 3, "too many waypoints");
  for (let i = 1; i < links.length; i++) eq(links[i].searchParams.get("origin"), links[i - 1].searchParams.get("destination"), "legs connect");
  eq(links[0].searchParams.get("travelmode"), "walking");
  eq(links.length, Math.ceil((routes[0].stops.length - 1) / 4), "no one point leg");
});

console.log("export and walk");
test("CSV fields with commas, quotes and newlines survive a round trip; a stray quote does not eat the file", () => {
  const cells = ["plain", "North Side, South Side", 'say "hi"', "two\nlines", ""];
  eq(parseCsv(csvRow(cells) + "\r\n")[0], cells);
  eq(parseCsv('a,b"c,d\r\n1,2,3'), [["a", 'b"c', "d"], ["1", "2", "3"]]);
});
test("HubSpot import: stock headers first, clean name, legal name kept, expediter phone moved, owner group, formulas defused", () => {
  const shared = score(prospect({ camis: "2", name: "=Hyperlink Kitchen LLC", phone: "+19295550111", phoneShared: 3 }));
  const owned = score(prospect({ camis: "3", owner: "Hudson Cabin" }));
  const rows = parseCsv(hubspotCsv([{ s: score(prospect({ name: "Happy Seafood Restaurant INC" })), route: "BK01", order: 1 }, { s: shared }, { s: owned }]));
  const col = (r: string[], h: string) => r[rows[0].indexOf(h)];
  eq(rows[0], HUBSPOT_HEADER);
  eq(rows[0].slice(0, 10), ["Company name", "Phone Number", "Street Address", "City", "State/Region", "Postal Code", "Country/Region", "Industry", "Lifecycle Stage", "Lead Status"]);
  eq(rows.length, 4);
  eq([col(rows[1], "Company name"), col(rows[1], "preopen filed name"), col(rows[1], "City"), col(rows[1], "preopen neighborhood")],
    ["Happy Seafood Restaurant", "Happy Seafood Restaurant INC", "Brooklyn", "North Side, South Side"]);
  eq([col(rows[2], "Phone Number"), col(rows[2], "preopen shared phone")], ["", "+19295550111"]);
  eq(col(rows[2], "Company name"), "'=Hyperlink Kitchen");
  eq(col(rows[3], "preopen owner group"), "Hudson Cabin");
  eq([safeText("+1 trick"), safeText("Plain")], ["'+1 trick", "Plain"]);
});
test("the skip audit lists every skipped business with its reasons, and the committed copy has no phone column", () => {
  const scored = [score(prospect({ camis: "11", chain: true, chainLocations: 9 })), score(prospect({ camis: "12" }))];
  const full = parseCsv(skippedCsv(scored, true)), lean = parseCsv(skippedCsv(scored, false));
  eq([full.length, lean.length], [2, 2], "only the skipped one");
  ok(full[0].includes("phone") && !lean[0].includes("phone"), "phone column only in the full file");
  ok(lean[1].at(-1)!.includes("chain with 9"), "reason carried");
});
test("Wilson interval matches the textbook value", () => {
  const w = wilson(20, 25);
  ok(near(w.low, 0.6087) && near(w.high, 0.9114), `got ${w.low}, ${w.high}`);
  eq(wilson(0, 0), { low: 0, high: 1 });
});
test("walk results: pending, one verdict per door, done only when every door is checked, stale when the route changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "preopen-"));
  try {
    const f = join(dir, "walk.csv");
    const { routes } = buildRoutes(grid(25));
    const ids = routes[0].stops.map((s) => s.camis);
    eq(readWalk(f, ids).status, "pending");
    writeFileSync(f, "");
    eq(readWalk(f, ids).status, "pending", "empty file");
    const rows = parseCsv(walkTemplate(routes[0]));
    eq(rows[0], WALK_HEADER);
    const st = ["pre_open", "pre_open", "just_opened", "open_old", "closed", "typo"];
    for (let i = 0; i < st.length; i++) rows[i + 1][5] = st[i];
    const recheck = [...rows[1]]; recheck[5] = "closed";
    writeFileSync(f, [...rows, recheck].map(csvRow).join("\r\n"));
    const w = readWalk(f, ids);
    eq([w.status, w.checked, w.hits, w.invalid.length, w.offRoute], ["partial", 5, 2, 1, 0], "the recheck replaces the first verdict");
    const all = rows.map((r, i) => (i === 0 ? r : [...r.slice(0, 5), "pre_open", ...r.slice(6)]));
    writeFileSync(f, [...all, ...all.slice(1, 3)].map(csvRow).join("\r\n"));
    eq([readWalk(f, ids).status, readWalk(f, ids).checked], ["done", ids.length], "duplicates never push checked past the route");
    const other = readWalk(f, ["99999999"]);
    eq([other.status, other.checked], ["stale", 0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("snapshot diff finds new applications and departures", () => {
  const a: Snapshot = { fetchedAt: "a", source: "", rows: [{ camis: "1" }, { camis: "2" }] };
  const b: Snapshot = { fetchedAt: "b", source: "", rows: [{ camis: "2" }, { camis: "3" }] };
  const d = diffSnapshots(a, b);
  eq([d.added.map((r) => r.camis), d.left.map((r) => r.camis), d.unchanged], [["3"], ["1"], 1]);
});

console.log("committed snapshot (end to end)");
const snap = loadSnapshot();
const p = pipeline(snap);
test("snapshot is the 1900-01-01 pre inspection marker only, and the reference holds only inspected places", () => {
  ok(snap.rows.length > 1000, "snapshot too small");
  ok(snap.rows.every((r) => r.inspection_date === "1900-01-01T00:00:00.000"), "a row has a real inspection date");
  const ref = loadInspected().places;
  ok(ref.length > 10000 && ref.every((q) => q.first > "1901"), "reference rows must be inspected places");
  const pending = new Set(snap.rows.map((r) => r.camis));
  ok(!ref.some((q) => pending.has(q.camis)), "a CAMIS is either uninspected or inspected, never both");
});
test("no chain, franchise unit, established place, institution, building kitchen, site, kiosk, park, old or unmapped door is ever routed", () => {
  for (const r of p.routes) for (const s of r.stops)
    ok(s.qualified && !s.chain && !s.franchise && !s.repermit && !s.building && s.bizType !== "institutional" && !s.siteKind &&
      !isSeasonal(s.rawName, s.address) && !isParkConcession(s.address, s.zip) && s.freshness !== "stalled" && s.lat !== null, `${r.id} stop ${s.name}`);
});
test("every route day fits the caps, and no door appears twice", () => {
  const seen = new Set<string>();
  for (const r of p.routes) {
    ok(r.stops.length <= 25 && r.hours <= 6, `${r.id}: ${r.stops.length} stops, ${r.hours} h`);
    for (const s of r.stops) { ok(!seen.has(s.camis), `duplicate ${s.camis}`); seen.add(s.camis); }
  }
  eq(seen.size + p.unrouted.length, p.qualified.length, "routed plus call list equals qualified");
});
test("the import holds every qualified door once, and never puts an expediter's shared line in a Phone Number", () => {
  const rows = parseCsv(hubspotCsv([...routeStops(p.routes), ...p.unrouted.map((s) => ({ s }))]));
  const phone = rows[0].indexOf("Phone Number"), shared = rows[0].indexOf("preopen shared phone"), camis = rows[0].indexOf("preopen camis");
  eq(new Set(rows.slice(1).map((r) => r[camis])).size, p.qualified.length);
  ok(rows.slice(1).every((r) => !(r[phone] && r[shared])), "a row carries both");
  const sharedPhones = new Set(p.scored.filter((s) => s.phoneShared).map((s) => s.phone));
  ok(rows.slice(1).every((r) => !sharedPhones.has(r[phone])), "a shared line leaked into Phone Number");
});
test("sites hold distinct filings: the summary's filing count equals the filings tagged as sites", () => {
  const sites = siteList(p.scored);
  eq(sites.reduce((a, s) => a + s.businesses, 0), p.scored.filter((s) => s.siteKind).length, "every site business is listed exactly once");
  eq(new Set(p.scored.filter((s) => s.siteKind).map((s) => s.siteKey)).size, sites.length, "one row per site");
  ok(sites.every((s) => s.filings >= s.businesses), "a site never lists more businesses than filings");
});
test("the published card data (app/card.json) carries no phone numbers", () => {
  const card = readFileSync(fileURLToPath(new URL("../app/card.json", import.meta.url)), "utf8");
  ok(card.length > 1000, "card.json missing or empty: run npm start");
  ok(!/\+1\d{10}|\(\d{3}\)\s?\d{3}|\b\d{3}[.\s]\d{3}[.\s]\d{4}\b/.test(card), "phone number found in card.json");
});
test("the committed skip audit (docs/skipped.csv) carries no phone numbers and covers every skipped business", () => {
  const rows = parseCsv(readFileSync(fileURLToPath(new URL("../docs/skipped.csv", import.meta.url)), "utf8"));
  eq(rows.length - 1, p.scored.filter((s) => !s.qualified).length);
  ok(!rows.some((r) => r.some((c) => /^\+1\d{10}$/.test(c))), "phone number found in docs/skipped.csv");
});
test("daily diff judges new rows against the whole list: a new kiosk at a market and a refiling are not new doors", () => {
  const site = p.scored.find((s) => s.siteKind === "address" && !s.flags.some((f) => f.startsWith("duplicate")))!;
  const door = p.routes[0].stops.find((s) => !s.flags.some((f) => f.startsWith("duplicate")))!;
  ok(site && door, "fixtures exist in the snapshot");
  const drop = new Set([site.camis, door.camis]);
  const prev: Snapshot = { ...snap, fetchedAt: "2026-10-13T03:00:00.000Z", rows: snap.rows.filter((r) => !drop.has(r.camis)) };
  const { fresh, doors } = newDoors(prev, snap);
  eq(fresh.length, 2);
  eq(doors.map((s) => s.camis), [door.camis], "only the real new door, not the new kiosk");
});
test("a refiling of a door already imported is not a new door", () => {
  const base = { boro: "Brooklyn", building: "2", street: "TEST LANE", zipcode: "11249", latitude: "40.7102", longitude: "-73.9602", inspection_date: "1900-01-01T00:00:00.000" };
  const door: RawRow = { ...base, camis: "50199990", dba: "JANES KITCHEN", phone: "7184440011" };
  const again: RawRow = { ...base, camis: "50199995", dba: "JANES KITCHEN NYC LLC", phone: "7184440012" };
  const prev: Snapshot = { fetchedAt: "2026-10-13T03:00:00.000Z", source: "", rows: [door] };
  const curr: Snapshot = { fetchedAt: "2026-10-14T03:00:00.000Z", source: "", rows: [door, again] };
  ok(pipeline(prev).qualified.some((s) => s.camis === "50199990"), "yesterday it was a door");
  const { doors, refilings } = newDoors(prev, curr);
  eq([doors.length, refilings], [0, 1]);
});
test("a refiling of a place that was skipped yesterday is judged fresh, not hidden as a repeat", () => {
  const base = { boro: "Brooklyn", building: "1", street: "TEST LANE", zipcode: "11249", latitude: "40.7101", longitude: "-73.9601", inspection_date: "1900-01-01T00:00:00.000" };
  const old: RawRow = { ...base, camis: "40000123", dba: "JOES KITCHEN", phone: "7184440001" };  // an old CAMIS: skipped as an old application
  const fresh: RawRow = { ...base, camis: "50199999", dba: "JOES KITCHEN NYC LLC", phone: "7184440002" };
  const prev: Snapshot = { fetchedAt: "2026-10-13T03:00:00.000Z", source: "", rows: [old] };
  const curr: Snapshot = { fetchedAt: "2026-10-14T03:00:00.000Z", source: "", rows: [old, fresh] };
  const { doors, refilings } = newDoors(prev, curr);
  eq([doors.map((s) => s.camis), refilings], [["50199999"], 0]);
});
const summary = summarize(snap, p);
test("the committed card data matches a fresh run of the engine", () => {
  const card = JSON.parse(readFileSync(fileURLToPath(new URL("../app/card.json", import.meta.url)), "utf8"));
  eq(card.summary.funnel, summary.funnel, "funnel");
  eq([card.summary.routes.count, card.summary.routes.doors, card.summary.sites.count, card.summary.walk.route, card.summary.evidence],
    [summary.routes.count, summary.routes.doors, summary.sites.count, summary.walk.route, summary.evidence], "routes, sites, walk route, evidence");
});
test("every number the README states matches the engine", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const n = (x: number) => x.toLocaleString("en-US");
  for (const f of summary.funnel) ok(readme.includes(` ${n(f.n)}  ${f.step}`), `funnel line "${n(f.n)}  ${f.step}"`);
  const r = summary.routes, e = summary.evidence;
  for (const claim of [
    `${r.count} days, median ${r.medianDoors} doors, ${r.medianKm.toFixed(1)} km and ${r.medianHours.toFixed(1)} hours a day`,
    `${summary.sites.count} sites hold ${n(summary.sites.filings)} filings`,
    `${n(summary.repermits)} filings belong to a place the city already inspects`,
    `${n(summary.established.fresh)} are an established business taking out a fresh permit`,
    `${n(summary.established.alreadyOpen)} are already open`,
    `${n(summary.established.sameLine)} carry the phone line of a place`,
    `${n(summary.franchiseUnits)} filings are franchise units the chain rule alone would miss`,
    `scores run ${summary.scoreRange.min.toFixed(2)} to ${summary.scoreRange.max.toFixed(2)}`,
    `${n(summary.qualifiedByType.restaurant ?? 0)} of the ${n(p.qualified.length)} qualified places`,
    `then the ${n(r.unrouted)} no walking day reached`,
    `one route is the check route: ${summary.walk.route}`,
    `${n(summary.funnel[0].n)} of them`,
    `${n(e.operational)} of ${n(e.operational + e.notYet)} (${Math.round((100 * e.operational) / (e.operational + e.notYet))}%)`,
    `rank correlation with first inspection date is ${e.rho.toFixed(2)} across ${n(e.rhoN)} places`,
    `${n(loadInspected().places.length)} places the city has already inspected`,
  ]) ok(readme.includes(claim), `README is missing or out of date: "${claim}"`);
});
test("a snapshot pulled late on the last night of a month belongs to that month", () => {
  eq(pipeline({ ...snap, fetchedAt: "2026-11-01T03:30:00.000Z" }).asOf, "2026-10");
});
test("no name in the real data or on the card carries a control character", () => {
  ok(!p.scored.some((s) => /[\u0000-\u001f\u007f-\u009f]/.test(s.name + s.rawName)), "a control character reached a scored name");
  const card = readFileSync(fileURLToPath(new URL("../app/card.json", import.meta.url)), "utf8");
  ok(!/\\u00[01][0-9a-f]/i.test(card), "a control character reached card.json");
});
test("scores on the real data stay in range", () => {
  ok(p.scored.every((s) => s.score >= SCORE_FLOOR && s.score <= SCORE_CEIL), "score out of range");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
