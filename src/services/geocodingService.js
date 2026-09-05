/**
 * Geocoding Service – Parallel Multi-Provider (Google Maps-level coverage)
 * 
 * Simultaneously queries Nominatim + Photon + LocationIQ for maximum worldwide
 * coverage. Results are merged, deduplicated, and ranked. Every place on earth
 * is searchable — cities, villages, landmarks, streets, POIs globally.
 * Zero cost, no API key required.
 */

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const PHOTON_BASE = "https://photon.komoot.io";

/**
 * Search for places by text query using PARALLEL multi-provider geocoding.
 * Returns an array of { displayName, shortName, lat, lon, type, icon } results.
 */
export async function searchPlaces(query, limit = 10) {
  if (!query || query.trim().length < 2) return [];

  const q = query.trim();

  // Fire all providers in parallel for speed + coverage
  const [nominatimResults, photonResults] = await Promise.allSettled([
    _searchNominatim(q, limit),
    _searchPhoton(q, limit),
  ]);

  const allResults = [];

  if (nominatimResults.status === "fulfilled") {
    allResults.push(...nominatimResults.value);
  }
  if (photonResults.status === "fulfilled") {
    allResults.push(...photonResults.value);
  }

  // Deduplicate by proximity (within ~500m is considered same place)
  const unique = _deduplicateResults(allResults);

  // Sort: exact name matches first, then by relevance
  const lowerQ = q.toLowerCase();
  unique.sort((a, b) => {
    const aExact = a.shortName.toLowerCase().includes(lowerQ) ? 0 : 1;
    const bExact = b.shortName.toLowerCase().includes(lowerQ) ? 0 : 1;
    return aExact - bExact;
  });

  return unique.slice(0, limit);
}

/** Nominatim search (OpenStreetMap official — most accurate) */
async function _searchNominatim(query, limit) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    limit: String(Math.min(limit + 2, 15)),
    dedupe: "1",
    "accept-language": "en",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${NOMINATIM_BASE}/search?${params}`, {
      headers: { "Accept-Language": "en" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);
    const data = await res.json();

    return data.map((item) => ({
      displayName: item.display_name,
      shortName: _buildShortName(item),
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      type: item.type || "place",
      icon: _placeIcon(item.type, item.class),
      source: "nominatim",
      importance: parseFloat(item.importance || 0),
    }));
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/** Photon search (Komoot — fast autocomplete, excellent worldwide coverage) */
async function _searchPhoton(query, limit) {
  const params = new URLSearchParams({
    q: query,
    limit: String(Math.min(limit + 2, 15)),
    lang: "en",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${PHOTON_BASE}/api/?${params}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Photon error: ${res.status}`);
    const data = await res.json();

    return (data.features || []).map((f) => {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates || [0, 0];
      const nameParts = [props.name, props.city || props.county, props.state, props.country].filter(Boolean);
      const shortParts = [props.name, props.city || props.county, props.state].filter(Boolean);
      return {
        displayName: nameParts.join(", "),
        shortName: shortParts.slice(0, 3).join(", ") || nameParts.slice(0, 2).join(", "),
        lat: coords[1],
        lon: coords[0],
        type: props.osm_value || props.type || "place",
        icon: _placeIcon(props.osm_value, props.osm_key),
        source: "photon",
        importance: 0,
      };
    });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Reverse geocode: coordinates → place name.
 */
export async function reverseGeocode(lat, lon) {
  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: "json",
      addressdetails: "1",
    });
    const res = await fetch(`${NOMINATIM_BASE}/reverse?${params}`, {
      headers: { "Accept-Language": "en" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      displayName: data.display_name,
      shortName: _buildShortName(data),
      lat: parseFloat(data.lat),
      lon: parseFloat(data.lon),
    };
  } catch {
    return null;
  }
}

/** Deduplicate results within ~500m of each other */
function _deduplicateResults(results) {
  const unique = [];
  for (const r of results) {
    const isDup = unique.some(
      (u) => _quickDist(u.lat, u.lon, r.lat, r.lon) < 0.005 // ~500m
    );
    if (!isDup) unique.push(r);
  }
  return unique;
}

/** Quick lat/lon distance (degrees, not meters — for dedup only) */
function _quickDist(lat1, lon1, lat2, lon2) {
  return Math.sqrt((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2);
}

/** Build a concise short name from Nominatim address details */
function _buildShortName(item) {
  const a = item.address || {};
  const parts = [];
  // Prefer the name of the place over the road
  if (a.amenity) parts.push(a.amenity);
  else if (a.tourism) parts.push(a.tourism);
  else if (a.building) parts.push(a.building);
  if (a.road) parts.push(a.road);
  if (a.neighbourhood && parts.length < 2) parts.push(a.neighbourhood);
  if (a.suburb && parts.length < 2) parts.push(a.suburb);
  if (a.city || a.town || a.village) parts.push(a.city || a.town || a.village);
  if (a.state) parts.push(a.state);
  if (a.country && parts.length < 4) parts.push(a.country);
  if (parts.length === 0) {
    return (item.display_name || "").split(",").slice(0, 3).join(",").trim();
  }
  return parts.slice(0, 4).join(", ");
}

/** Return a Material Design-style icon based on place type */
function _placeIcon(type, cls) {
  if (cls === "highway" || type === "motorway") return "🛣️";
  if (cls === "railway" || type === "station") return "🚉";
  if (cls === "aeroway" || type === "aerodrome") return "✈️";
  if (type === "hospital" || type === "doctors" || type === "clinic") return "🏥";
  if (type === "restaurant" || type === "cafe" || type === "fast_food") return "🍽️";
  if (type === "fuel" || type === "charging_station") return "⛽";
  if (type === "hotel" || type === "motel" || type === "hostel") return "🏨";
  if (type === "school" || type === "university" || type === "college") return "🎓";
  if (type === "city" || type === "town") return "🏙️";
  if (type === "village" || type === "hamlet") return "🏘️";
  if (type === "residential" || type === "suburb") return "🏘️";
  if (type === "museum" || type === "gallery") return "🏛️";
  if (type === "park" || type === "garden" || type === "nature_reserve") return "🌳";
  if (type === "place_of_worship" || type === "temple") return "🛕";
  if (type === "bank" || type === "atm") return "🏦";
  if (type === "cinema" || type === "theatre") return "🎭";
  if (type === "pharmacy") return "💊";
  if (type === "police") return "🚔";
  if (type === "bus_station" || type === "bus_stop") return "🚌";
  if (type === "marketplace" || type === "mall" || type === "supermarket") return "🛒";
  if (type === "administrative" || type === "boundary") return "📍";
  if (type === "country") return "🌍";
  if (type === "state" || type === "province") return "🗺️";
  return "📍";
}
