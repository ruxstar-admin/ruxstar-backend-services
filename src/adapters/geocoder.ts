import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../platform/errors.js";

export interface Geocoder {
  /** The city or town at a point, or null when the point is not in one. */
  cityAt(lat: number, lng: number): Promise<string | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 5000;

/**
 * OpenStreetMap's Nominatim. Its policy allows one request a second for the whole app and asks for
 * an identifying User-Agent; results must be credited to OpenStreetMap where they are shown.
 * Points are rounded to about 1 km before they leave this server, which also makes the cache useful.
 */
export class NominatimGeocoder implements Geocoder {
  private readonly cache = new Map<string, { city: string | null; at: number }>();
  private nextSlot = 0;

  constructor(private readonly log: FastifyBaseLogger) {}

  async cityAt(lat: number, lng: number): Promise<string | null> {
    const point = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const hit = this.cache.get(point);
    if (hit && Date.now() - hit.at < DAY_MS) return hit.city;

    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    if (wait > 5000) throw new AppError("LOCATION_UNAVAILABLE");
    this.nextSlot = Math.max(now, this.nextSlot) + 1100;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));

    const [plat, plng] = point.split(",");
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&accept-language=en&lat=${plat}&lon=${plng}`;
    let address: Record<string, string> = {};
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "ruxstar-api/2.0 (+https://ruxstar.com)" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      address = ((await res.json()) as { address?: Record<string, string> }).address ?? {};
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, "Nominatim lookup failed");
      throw new AppError("LOCATION_UNAVAILABLE");
    }

    const city = address.city ?? address.town ?? address.village ?? address.municipality ?? address.county ?? null;
    if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(point, { city, at: Date.now() });
    return city;
  }
}

export function createGeocoder(log: FastifyBaseLogger): Geocoder {
  return new NominatimGeocoder(log);
}
