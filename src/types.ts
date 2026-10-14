// Shared shapes for the preopen pipeline.

/** One row as NYC Open Data serves it (dataset 43nn-pn8j), only the fields we read. */
export interface RawRow {
  camis: string;
  dba?: string;
  boro?: string;
  building?: string;
  street?: string;
  zipcode?: string;
  phone?: string;
  inspection_date?: string;
  record_date?: string;
  bin?: string;                  // the city's building ID
  latitude?: string;
  longitude?: string;
  nta?: string;
  community_board?: string;
  council_district?: string;
}

export type BizType =
  | "cafe" | "bakery" | "pizza" | "bar" | "deli_market" | "dessert" | "juice"
  | "fast_casual" | "restaurant" | "institutional";

/**
 * Where a place stands against businesses with neighboring permit numbers (CAMIS): on_track when its peers are being
 * inspected about now, behind when they were inspected 4 to 12 months ago, stalled when over a year ago.
 */
export type Freshness = "on_track" | "behind" | "stalled";

/** A cleaned, classified prospect. */
export interface Prospect {
  camis: string;
  name: string;
  rawName: string;
  boro: string;
  address: string;
  zip: string;
  phone: string | null;          // E.164, or null when the record has no usable number
  lat: number | null;
  lon: number | null;
  nta: string | null;            // 2010 Neighborhood Tabulation Area code, e.g. BK73
  hood: string | null;           // its readable name, e.g. "North Side, South Side"
  bizType: BizType;
  chain: boolean;
  chainLocations: number;
  peerMonth: string;             // month its permit number peers got their first inspection, YYYY-MM (estimate)
  freshness: Freshness;
  newest: boolean;               // permit number above every business ever inspected: applied very recently
  siteSize: number;              // filings in this place's site group; at or above the kind's threshold it is a site
  siteKind: "address" | "cluster" | "phone" | null; // which rule made it a site, null when it is a storefront door
  siteKey: string | null;        // the group it belongs to, for the sites list
  phoneShared: number;           // addresses that share this NYC phone (3+ means an expediter's line, not the owner's)
  owner: string | null;          // one owner behind several new locations (same phone, same brand): one account, many lines
  bin: string | null;            // the city's building ID, null for placeholder IDs like 1000000
  repermit: { camis: string; name: string; first: string; newer: boolean; byPhone: boolean } | null; // the city already inspects this place under another CAMIS
  franchise: string | null;      // the phone also sits on inspected stores of this chain: a franchise operator's unit
  building: string | null;       // an inspected hotel, office or venue kitchen in the same building (e.g. "ROOM SERVICE")
  flags: string[];               // data problems a rep should know about
}

export interface Scored extends Prospect {
  score: number;                 // 0.40 to 0.95, never 1.00
  qualified: boolean;
  reasons: string[];
}

export interface Stop extends Scored {
  route: string;
  order: number;
}

export interface Route {
  id: string;
  boro: string;
  hood: string;                  // the most common neighborhood among its stops
  stops: Stop[];
  walkKm: number;
  hours: number;                 // walking plus 10 minutes per stop
  mapsLinks: string[];           // Google Maps walking links, 9 stops per link
}

export interface Snapshot {
  fetchedAt: string;
  source: string;
  rows: RawRow[];
}
