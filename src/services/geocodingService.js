/**
 * Geocoding Service – Nominatim (OpenStreetMap) Free API
 * 
 * Provides text-to-coordinates search with autocomplete-style
 * debounced suggestions. Zero cost, no API key required.
 */

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

/**
 * Search for places by text query.
 * Returns an array of { displayName, lat, lon, type } results.
 */
export async function searchPlaces(query, limit = 5) {
  if (!query || query.trim().length < 2) return [];

  const params = new URLSearchParams({
    q: query.trim(),
    format: "json",
    addressdetails: "1",
    limit: String(limit),
  });

  try {
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
  } catch (err) {
    console.warn("Geocoding search failed:", err.message);
    return [];
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
    // Fallback: take first 2 comma-separated segments
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
  return "📍";
}
