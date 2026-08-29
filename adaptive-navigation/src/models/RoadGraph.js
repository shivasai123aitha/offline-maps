/**
 * In-Memory Road Graph Model
 *
 * Wraps the raw adjacency-list graph with higher-level operations:
 * - Block/unblock edges (road closures)
 * - Spatial nearest-neighbor search
 * - Graph statistics
 */

import { haversine, findNearestNode } from "../services/osmService.js";

// Path references for service imports are from models/ → services/
// Adjust if directory structure changes.


export class RoadGraph {

  constructor(networkData) {
    // networkData: { graph, nodes, edgeMeta }
    this.nodes = { ...networkData.nodes };
    this.graph = {};
    this.edgeMeta = { ...(networkData.edgeMeta || {}) };
    this.blockedEdges = new Set();

    // Deep-clone adjacency lists so mutations don't affect source
    for (const id in networkData.graph) {
      this.graph[id] = networkData.graph[id].map(e => ({ ...e }));
    }
  }


  // ── Statistics ──────────────────────────────────────────
  get nodeCount() {
    return Object.keys(this.nodes).length;
  }

  get edgeCount() {
    let count = 0;
    for (const id in this.graph) {
      count += this.graph[id].length;
    }
    return Math.floor(count / 2); // undirected → halve
  }

  get boundingBox() {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (const id in this.nodes) {
      const { lat, lon } = this.nodes[id];
      s = Math.min(s, lat);
      n = Math.max(n, lat);
      w = Math.min(w, lon);
      e = Math.max(e, lon);
    }
    return { south: s, north: n, west: w, east: e };
  }


  // ── Nearest Node ───────────────────────────────────────
  findNearest(lat, lon) {
    return findNearestNode(this.nodes, lat, lon);
  }


  // ── Edge Blocking (Road Closures) ─────────────────────
  blockEdge(fromId, toId) {
    this.blockedEdges.add(`${fromId}-${toId}`);
    this.blockedEdges.add(`${toId}-${fromId}`);
  }

  unblockEdge(fromId, toId) {
    this.blockedEdges.delete(`${fromId}-${toId}`);
    this.blockedEdges.delete(`${toId}-${fromId}`);
  }

  clearAllBlocks() {
    this.blockedEdges.clear();
  }

  isBlocked(fromId, toId) {
    return this.blockedEdges.has(`${fromId}-${toId}`);
  }


  // ── Filtered Adjacency List ───────────────────────────
  // Returns neighbors excluding blocked edges
  getNeighbors(nodeId) {
    const edges = this.graph[nodeId] || [];
    return edges.filter(e => !this.isBlocked(nodeId, e.node));
  }


  // ── Get all edges as coordinate pairs (for rendering) ─
  getAllEdgesAsCoords() {
    const edges = [];
    const seen = new Set();

    for (const from in this.graph) {
      for (const edge of this.graph[from]) {
        const key = [from, edge.node].sort().join("-");
        if (seen.has(key)) continue;
        seen.add(key);

        const a = this.nodes[from];
        const b = this.nodes[edge.node];
        if (!a || !b) continue;

        edges.push({
          from: [a.lat, a.lon],
          to: [b.lat, b.lon],
          highway: edge.highway || "unclassified",
          blocked: this.isBlocked(from, edge.node),
        });
      }
    }

    return edges;
  }


  // ── Get all node coordinates (for rendering) ──────────
  getAllNodeCoords() {
    return Object.entries(this.nodes).map(([id, { lat, lon }]) => ({
      id,
      lat,
      lon,
    }));
  }


  // ── Serialization for cache persistence ───────────────
  serialize() {
    return JSON.stringify({
      nodes: this.nodes,
      graph: this.graph,
      edgeMeta: this.edgeMeta,
    });
  }

  static deserialize(json) {
    const data = JSON.parse(json);
    return new RoadGraph(data);
  }
}
