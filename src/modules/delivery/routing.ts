import type { FastifyInstance } from "fastify";
import { MongoServerError, type ObjectId } from "mongodb";
import type { Database, DeliveryJobDoc, DeliveryRouteDoc } from "../../platform/db.js";

export type LatLng = { lat: number; lng: number };
type Provider = DeliveryRouteDoc["provider"];
type Path = Pick<DeliveryRouteDoc, "polyline" | "distanceM" | "durationS" | "provider">;

export interface Leg extends Path {
  from: "here" | "shop";
  to: "shop" | "drop";
}

const TIMEOUT_MS = 4000;
const USER_AGENT = "ruxstar-api/2.0 (+https://ruxstar.com)";
/** Straight lines are timed at 20 km/h, in metres a second. */
const STRAIGHT_MPS = 20_000 / 3600;
const ROAD_KEEP_MS = 24 * 60 * 60_000;
const STRAIGHT_KEEP_MS = 5 * 60_000;
/** About 150 m; the rider's position is snapped to this grid, so moving within a cell reuses the route. */
const CELL_DEG = 0.00135;
/** Further than this isn't a trip, so the router isn't asked. */
const MAX_ROAD_M = 150_000;
/** Plenty for a smooth line on a phone; longer routes are thinned to this. */
const MAX_POINTS = 400;

/** A point a map can use: in range, and not 0,0, which is what a missing pin often turns into. */
export const usable = (p: LatLng | null | undefined): p is LatLng =>
  !!p &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180 &&
  !(Math.abs(p.lat) < 0.001 && Math.abs(p.lng) < 0.001);

export function metresBetween(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function straight(a: LatLng, b: LatLng): Path {
  const distanceM = Math.round(metresBetween(a, b));
  return { polyline: [[a.lat, a.lng], [b.lat, b.lng]], distanceM, durationS: Math.round(distanceM / STRAIGHT_MPS), provider: "straight" };
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

const thin = (points: [number, number][]): [number, number][] => {
  const step = Math.max(1, (points.length - 1) / (MAX_POINTS - 1));
  const kept = points.length <= MAX_POINTS ? points : Array.from({ length: MAX_POINTS }, (_, i) => points[Math.round(i * step)]!);
  return kept.map(([lat, lng]) => [round5(lat), round5(lng)]);
};

/** Google's encoded polyline format, as [lat, lng] pairs. */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push([lat / 1e5, lng / 1e5]);
  }
  if (points.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) throw new Error("Bad polyline");
  return points;
}

async function google(key: string, a: LatLng, b: LatLng): Promise<Path> {
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
      destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
      travelMode: "TWO_WHEELER",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  type Body = { routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }[] };
  const route = ((await res.json()) as Body).routes?.[0];
  const polyline = route?.polyline?.encodedPolyline ? decodePolyline(route.polyline.encodedPolyline) : [];
  if (!route || polyline.length < 2) throw new Error("no route");
  return { polyline: thin(polyline), distanceM: Math.round(route.distanceMeters ?? 0), durationS: Math.round(parseFloat(route.duration ?? "0") || 0), provider: "google" };
}

async function osrm(a: LatLng, b: LatLng): Promise<Path> {
  // OSRM's public demo server is for testing only: about one request a second and no uptime promise. Production sets GOOGLE_ROUTES_API_KEY.
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  type Body = { code?: string; routes?: { distance: number; duration: number; geometry?: { coordinates?: [number, number][] } }[] };
  const body = (await res.json()) as Body;
  const route = body.code === "Ok" ? body.routes?.[0] : undefined;
  const coordinates = route?.geometry?.coordinates ?? [];
  if (!route || coordinates.length < 2) throw new Error(`no route (${body.code ?? "no code"})`);
  return {
    polyline: thin(coordinates.map(([lng, lat]) => [lat, lng])),
    distanceM: Math.round(route.distance),
    durationS: Math.round(route.duration),
    provider: "osrm",
  };
}

/** The road from `a` to `b`: Google's Routes API with a key, otherwise OSRM; a straight line when the router fails. Never throws. */
export async function routeBetween(app: Pick<FastifyInstance, "config" | "log">, a: LatLng, b: LatLng): Promise<Path> {
  if (metresBetween(a, b) > MAX_ROAD_M) return straight(a, b);
  const key = app.config.googleRoutesKey;
  try {
    return key ? await google(key, a, b) : await osrm(a, b);
  } catch (err) {
    app.log.warn({ error: (err as Error).message, provider: key ? "google" : "osrm" }, "Routing failed; drawing a straight line");
    return straight(a, b);
  }
}

async function cachedRoute(app: FastifyInstance, db: Database, jobId: ObjectId, key: string, a: LatLng, b: LatLng): Promise<Path> {
  const now = new Date();
  const hit = await db.deliveryRoutes.findOne({ _id: key, expiresAt: { $gt: now } });
  if (hit) return { polyline: hit.polyline, distanceM: hit.distanceM, durationS: hit.durationS, provider: hit.provider };
  const path = await routeBetween(app, a, b);
  const expiresAt = new Date(now.getTime() + (path.provider === "straight" ? STRAIGHT_KEEP_MS : ROAD_KEEP_MS));
  await db.deliveryRoutes.replaceOne({ _id: key }, { jobId, ...path, createdAt: now, expiresAt }, { upsert: true }).catch((err: unknown) => {
    // Two requests for the same route at once: the other one saved it.
    if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
  });
  return path;
}

const cell = (here: LatLng) => `${Math.round(here.lat / CELL_DEG)},${Math.round(here.lng / CELL_DEG)}`;

/**
 * The rider's map: on the way to the shop, from here to the shop and then the shop to the customer; after pickup, from here to
 * the customer (or the shop to the customer without a location). Stops without a usable pin are left out.
 */
export async function tripRoute(app: FastifyInstance, db: Database, job: DeliveryJobDoc, here: LatLng | null): Promise<{ legs: Leg[]; provider: Provider }> {
  const shop = usable(job.pickup.point) ? job.pickup.point : null;
  const drop = usable(job.drop.point) ? job.drop.point : null;
  const id = job._id.toHexString();
  const toShop = job.status === "accepted";
  const next = toShop ? { to: "shop" as const, point: shop } : { to: "drop" as const, point: drop };
  const plan: { from: Leg["from"]; to: Leg["to"]; a: LatLng; b: LatLng; key: string }[] = [];
  if (here && next.point) plan.push({ from: "here", to: next.to, a: here, b: next.point, key: `${id}:here-${next.to}:${cell(here)}` });
  if (shop && drop && (toShop || !here)) plan.push({ from: "shop", to: "drop", a: shop, b: drop, key: `${id}:shop-drop` });
  const legs = await Promise.all(plan.map(async ({ from, to, a, b, key }) => ({ from, to, ...(await cachedRoute(app, db, job._id, key, a, b)) })));
  const provider: Provider =
    !legs.length || legs.some((l) => l.provider === "straight") ? "straight" : legs.some((l) => l.provider === "google") ? "google" : "osrm";
  return { legs, provider };
}
