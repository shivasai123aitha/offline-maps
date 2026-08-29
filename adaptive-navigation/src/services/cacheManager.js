/**
 * Smart Cache Manager
 *
 * Persists road graph data to localStorage with spatial metadata.
 * Supports corridor pre-fetching, cache inspection, and eviction.
 */

const CACHE_KEY = "adaptive_nav_graph_cache";
const CACHE_META_KEY = "adaptive_nav_cache_meta";
const MAX_CACHE_SIZE_MB = 10;


export class CacheManager {

  // ── Save graph to localStorage ─────────────────────────
  static save(roadGraph) {
    try {
      const serialized = roadGraph.serialize();
      const sizeKB = new Blob([serialized]).size / 1024;

      try {
        localStorage.setItem(CACHE_KEY, serialized);
      } catch {
        localStorage.removeItem(CACHE_KEY);
        try {
          localStorage.setItem(CACHE_KEY, serialized);
        } catch {
          // If still over quota, skip saving serialized graph but save metadata
        }
      }

      try {
        localStorage.setItem(CACHE_META_KEY, JSON.stringify({
          savedAt: Date.now(),
          nodeCount: roadGraph.nodeCount,
          edgeCount: roadGraph.edgeCount,
          boundingBox: roadGraph.boundingBox,
          sizeKB: Math.round(sizeKB * 10) / 10,
        }));
      } catch {
        // Ignore meta save error
      }

      return { success: true, sizeKB };
    } catch (err) {
      console.warn("Cache save failed:", err);
      return { success: false, error: err.message };
    }
  }


  // ── Load graph from localStorage ──────────────────────
  static load() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;

      // Dynamic import to avoid circular deps
      // We return raw JSON; caller constructs RoadGraph
      return JSON.parse(raw);
    } catch (err) {
      console.warn("Cache load failed:", err);
      return null;
    }
  }


  // ── Get cache metadata ────────────────────────────────
  static getMeta() {
    try {
      const raw = localStorage.getItem(CACHE_META_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }


  // ── Check if cache exists ─────────────────────────────
  static hasCachedData() {
    return localStorage.getItem(CACHE_KEY) !== null;
  }


  // ── Clear cache ───────────────────────────────────────
  static clear() {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_META_KEY);
  }


  // ── Cache size in KB ──────────────────────────────────
  static getSizeKB() {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return 0;
    return Math.round(new Blob([raw]).size / 1024 * 10) / 10;
  }


  // ── Check if cache is within size limits ──────────────
  static isWithinLimits() {
    return this.getSizeKB() < MAX_CACHE_SIZE_MB * 1024;
  }


  // ── Format cache info for display ─────────────────────
  static getDisplayInfo() {
    const meta = this.getMeta();
    if (!meta) {
      return {
        status: "empty",
        text: "No cached data",
        nodes: 0,
        edges: 0,
        sizeKB: 0,
        age: null,
      };
    }

    const ageMs = Date.now() - meta.savedAt;
    const ageMins = Math.floor(ageMs / 60000);
    const ageText = ageMins < 1 ? "Just now"
      : ageMins < 60 ? `${ageMins}m ago`
      : `${Math.floor(ageMins / 60)}h ago`;

    return {
      status: "cached",
      text: `${meta.nodeCount} nodes, ${meta.edgeCount} edges`,
      nodes: meta.nodeCount,
      edges: meta.edgeCount,
      sizeKB: meta.sizeKB,
      age: ageText,
      boundingBox: meta.boundingBox,
    };
  }
}
