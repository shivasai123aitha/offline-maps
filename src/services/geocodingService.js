/**
 * Geocoding Service – Multi-Provider (Nominatim + Photon)
 * 
 * Uses Nominatim primary + Photon fallback for maximum worldwide coverage.
 * Every place on earth is searchable. Zero cost, no API key required.
 */

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const PHOTON_BASE = "https://photon.komoot.io";

/**
 * Search for places by text query using multiple geocoding providers.
 * Returns an array of { displayName, shortName, lat, lon, type, icon } results.
 */
export async function searchPlaces(query, limit = 8) {
  if (!query || query.trim().length < 2) return [];

  // Try Nominatim first (most accurate)
  try {
    const results = await _searchNominatim(query, limit);
    if (results.length > 0) return results;
  } catch (err) {
    console.warn("Nominatim search failed:", err.message);
  }

  // Fallback: Photon (faster autocomplete, great worldwide coverage)
  try {
    return await _searchPhoton(query, limit);
  } catch (err) {
    console.warn("Photon search also failed:", err.message);
    return [];
  }
}

/** Nominatim search (OpenStreetMap official) */
async function _searchNominatim(query, limit) {
  const params = new URLSearchParams({
    q: query.trim(),
    format: "json",
    addressdetails: "1",
    limit: String(limit),
    dedupe: "1",
  });

  const res = await fetch(`${NOMINATIM_BASE}/search?${params}`, {
    headers: { "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);
  const data = await res.json();

  return data.map((item) => ({
    displayName: item.display_name,
    shortName: _buildShortName(item),
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
    type: item.type || "place",
    icon: _placeIcon(item.type, item.class),
  }));
}

/** Photon search (Komoot, powered by OSM – fast autocomplete) */
async function _searchPhoton(query, limit) {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(limit),
    lang: "en",
  });

  const res = await fetch(`${PHOTON_BASE}/api/?${params}`);
  if (!res.ok) throw new Error(`Photon error: ${res.status}`);
  const data = await res.json();

  return (data.features || []).map((f) => {
    const props = f.properties || {};
    const coords = f.geometry?.coordinates || [0, 0];
    const parts = [props.name, props.city, props.state, props.country].filter(Boolean);
    return {
      displayName: parts.join(", "),
      shortName: parts.slice(0, 3).join(", "),
      lat: coords[1],
      lon: coords[0],
      type: props.osm_value || "place",
      icon: _placeIcon(props.osm_value, props.osm_key),
    };
  });
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

/** Build a concise short name from Nominatim address details */
function _buildShortName(item) {
  const a = item.address || {};
  const parts = [];
  if (a.road) parts.push(a.road);
  if (a.neighbourhood) parts.push(a.neighbourhood);
  if (a.suburb) parts.push(a.suburb);
  if (a.city || a.town || a.village) parts.push(a.city || a.town || a.village);
  if (a.state) parts.push(a.state);
  if (parts.length === 0) {
    return (item.display_name || "").split(",").slice(0, 2).join(",").trim();
  }
  return parts.slice(0, 3).join(", ");
}

/** Return an emoji icon based on place type */
function _placeIcon(type, cls) {
  if (cls === "highway" || type === "motorway") return "🛣️";
  if (cls === "railway" || type === "station") return "🚉";
  if (cls === "aeroway" || type === "aerodrome") return "✈️";
  if (type === "hospital" || type === "doctors") return "🏥";
  if (type === "restaurant" || type === "cafe") return "🍽️";
  if (type === "fuel") return "⛽";
  if (type === "hotel" || type === "motel") return "🏨";
  if (type === "school" || type === "university" || type === "college") return "🎓";
  if (type === "city" || type === "town" || type === "village") return "🏙️";
  if (type === "residential") return "🏘️";
  if (type === "administrative") return "📍";
  if (type === "suburb" || type === "hamlet") return "🏘️";
  return "📍";
}
