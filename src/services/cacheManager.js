/**
 * Pure In-Memory Cache Manager (Zero Browser Disk Storage)
 *
 * Keeps all corridor road graphs and navigation states strictly in
 * volatile JavaScript RAM (0 KB localStorage footprint).
 * Ensures complete privacy and zero device disk usage.
 */

const CACHE_KEY = "adaptive_nav_graph_cache";
const CACHE_META_KEY = "adaptive_nav_cache_meta";

// Volatile in-memory store (RAM only, 0 bytes disk storage)
let memoryGraph = null;
let memoryMeta = null;

// Wipe any previous localStorage residue on startup
try {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_META_KEY);
  }
} catch {
  // Ignore
}

export class CacheManager {

  // ── Save graph to volatile RAM (0 KB disk) ─────────────
  static save(roadGraph) {
    try {
      if (!roadGraph) return { success: false };

      memoryGraph = roadGraph.serialize ? JSON.parse(roadGraph.serialize()) : roadGraph;
      memoryMeta = {
        savedAt: Date.now(),
        nodeCount: roadGraph.nodeCount || Object.keys(roadGraph.nodes || {}).length,
        edgeCount: roadGraph.edgeCount || 0,
        boundingBox: roadGraph.boundingBox || null,
        storageType: "RAM (Volatile)",
      };

      return { success: true, sizeKB: 0 };
    } catch (err) {
      console.warn("In-memory cache save error:", err);
      return { success: false, error: err.message };
    }
  }


  // ── Load graph from volatile RAM ───────────────────────
  static load() {
    return memoryGraph;
  }


  // ── Get cache metadata ─────────────────────────────────
  static getMeta() {
    return memoryMeta;
  }


  // ── Check if in-memory cache exists ────────────────────
  static hasCachedData() {
    return memoryGraph !== null;
  }


  // ── Clear in-memory cache and disk storage ─────────────
  static clear() {
    memoryGraph = null;
    memoryMeta = null;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_META_KEY);
      }
    } catch {
      // Ignore
    }
  }


  // ── Disk size is strictly 0 KB ─────────────────────────
  static getSizeKB() {
    return 0; // 0 KB disk storage
  }


  // ── Format cache info for display ──────────────────────
  static getDisplayInfo() {
    const meta = this.getMeta();
    if (!meta || !memoryGraph) {
      return {
        exists: false,
        status: "empty",
        text: "0 KB Disk (RAM Only)",
        nodes: 0,
        edges: 0,
        sizeKB: 0,
        storage: "RAM (0 KB Disk)",
      };
    }

    return {
      exists: true,
      status: "cached",
      text: `0 KB Disk — ${meta.nodeCount} nodes in RAM`,
      nodes: meta.nodeCount,
      edges: meta.edgeCount,
      sizeKB: 0,
      storage: "RAM (0 KB Disk)",
      meta,
    };
  }
}
