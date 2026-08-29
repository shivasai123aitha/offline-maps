/**
 * A* Pathfinding Algorithm
 *
 * Optimized A* with:
 * - Haversine heuristic
 * - Time-cost weighting (distance / speed)
 * - Blocked edge awareness via RoadGraph model
 * - Route metadata output (distance, time, node count)
 */

import { haversine } from "../services/osmService.js";


/**
 * Run A* pathfinding on a RoadGraph instance.
 *
 * @param {RoadGraph} roadGraph - The road graph model
 * @param {string} startId - Start node ID
 * @param {string} goalId - Goal node ID
 * @param {"distance"|"time"} optimize - Optimization target
 * @returns {{ path: string[], coords: [number,number][], distance: number, time: number } | null}
 */
export function aStar(roadGraph, startId, goalId, optimize = "time") {
  startId = String(startId);
  goalId = String(goalId);
  const { nodes } = roadGraph;

  if (!nodes[startId] || !nodes[goalId]) return null;
  if (startId === goalId) {
    return {
      path: [startId],
      coords: [[nodes[startId].lat, nodes[startId].lon]],
      distance: 0,
      time: 0,
    };
  }

  const openSet = new Set([startId]);
  const cameFrom = {};
  const gScore = {};
  const fScore = {};

  // Initialize scores
  for (const id in nodes) {
    gScore[id] = Infinity;
    fScore[id] = Infinity;
  }

  gScore[startId] = 0;
  fScore[startId] = heuristic(nodes[startId], nodes[goalId]);

  while (openSet.size > 0) {
    // Find node in openSet with lowest fScore
    let current = null;
    let bestF = Infinity;
    for (const id of openSet) {
      if (fScore[id] < bestF) {
        bestF = fScore[id];
        current = id;
      }
    }

    if (current === null) break;

    // Reached goal
    if (String(current) === goalId) {
      return reconstructPath(current, cameFrom, nodes, roadGraph);
    }

    openSet.delete(current);

    // Explore neighbors (respecting blocked edges)
    const neighbors = roadGraph.getNeighbors(current);

    for (const edge of neighbors) {
      const neighbor = String(edge.node);

      // Cost depends on optimization target
      const edgeCost = optimize === "time"
        ? edge.timeCost
        : edge.distance;

      const tentativeG = gScore[current] + edgeCost;

      if (tentativeG < gScore[neighbor]) {
        cameFrom[neighbor] = { from: current, edge };
        gScore[neighbor] = tentativeG;

        // Heuristic scaled by speed for time optimization
        const h = optimize === "time"
          ? heuristic(nodes[neighbor], nodes[goalId]) / 60  // assume 60 km/h avg
          : heuristic(nodes[neighbor], nodes[goalId]);

        fScore[neighbor] = tentativeG + h;

        openSet.add(neighbor);
      }
    }
  }

  // No path found
  return null;
}


// ── Reconstruct path and compute metadata ────────────────
function reconstructPath(goalId, cameFrom, nodes, roadGraph) {
  const path = [goalId];
  let current = goalId;
  let totalDist = 0;
  let totalTime = 0;

  while (current in cameFrom) {
    const { from, edge } = cameFrom[current];
    totalDist += edge.distance;
    totalTime += edge.timeCost;
    current = from;
    path.push(current);
  }

  path.reverse();

  const coords = path.map(id => [nodes[id].lat, nodes[id].lon]);

  return {
    path,
    coords,
    distance: Math.round(totalDist * 100) / 100,     // km, 2 decimals
    time: Math.round(totalTime * 60 * 10) / 10,       // minutes, 1 decimal
  };
}


// ── Haversine heuristic (km) ────────────────────────────
function heuristic(a, b) {
  return haversine(a, b);
}