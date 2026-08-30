/**
 * OpenStreetMap & Global Routing Data Service
 * 
 * Provides:
 * - High-speed Global OSRM driving engine (unlimited distance, sub-100ms routing)
 * - Automatic Corridor Graph generation for in-browser offline A* pathfinding
 * - Overpass API raw OSM data fetch
 * - Built-in fallback datasets and distance math helpers
 */

// ─── Haversine distance (km) ───────────────────────────────
export function haversine(a, b) {
  const R = 6371;
  const toRad = (deg) => deg * Math.PI / 180;
  const lat1 = toRad(a.lat !== undefined ? a.lat : a[0]);
  const lat2 = toRad(b.lat !== undefined ? b.lat : b[0]);
  const dLat = toRad((b.lat !== undefined ? b.lat : b[0]) - (a.lat !== undefined ? a.lat : a[0]));
  const dLon = toRad((b.lon !== undefined ? b.lon : b[1]) - (a.lon !== undefined ? a.lon : a[1]));

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}


// ─── Bearing between two points (degrees) ─────────────────
export function bearing(a, b) {
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const lat1 = toRad(a.lat !== undefined ? a.lat : a[0]);
  const lat2 = toRad(b.lat !== undefined ? b.lat : b[0]);
  const dLon = toRad((b.lon !== undefined ? b.lon : b[1]) - (a.lon !== undefined ? a.lon : a[1]));

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}


// ─── Speed limits by highway type (km/h) ──────────────────
export const SPEED_LIMITS = {
  motorway: 100,
  trunk: 80,
  primary: 60,
  secondary: 50,
  tertiary: 40,
  residential: 30,
  unclassified: 30,
  service: 20,
  living_street: 15,
  track: 15,
  footway: 5,
  path: 5,
  cycleway: 15,
  motorway_link: 60,
  trunk_link: 50,
  primary_link: 40,
  secondary_link: 35,
  tertiary_link: 30,
};


// ─── Maneuver Icon and Description Mapping ────────────────
export function mapOSRMModifierToIcon(type, modifier) {
  if (type === "depart") return "🚀";
  if (type === "arrive") return "🏁";
  if (type === "roundabout" || type === "rotary") return "🔄";
  if (modifier === "uturn") return "🔄";
  if (modifier === "sharp right") return "↘️";
  if (modifier === "right") return "➡️";
  if (modifier === "slight right") return "↗️";
  if (modifier === "sharp left") return "↙️";
  if (modifier === "left") return "⬅️";
  if (modifier === "slight left") return "↖️";
  if (modifier === "straight" || type === "continue") return "⬆️";
  return "⬆️";
}


// ─── Fetch Global Route via OSRM (Unlimited distance, sub-100ms) ─
export async function fetchGlobalRoute(startLat, startLon, destLat, destLon) {
  const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${destLon},${destLat}?overview=full&geometries=geojson&steps=true&annotations=true`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM API error: ${response.status}`);
  }

  const data = await response.json();
  if (!data.routes || data.routes.length === 0) {
    throw new Error("No route found between these points.");
  }

  const route = data.routes[0];
  // Convert GeoJSON [lon, lat] coordinates to Leaflet [lat, lon]
  const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const distanceKm = Math.round((route.distance / 1000) * 100) / 100;
  const timeMin = Math.round((route.duration / 60) * 10) / 10;

  // Build node path
  const path = coords.map((_, idx) => `corridor_node_${idx}`);

  // Build turn-by-turn instructions from OSRM steps
  const instructions = [];
  let accumulatedDist = 0;

  if (route.legs && route.legs[0] && route.legs[0].steps) {
    const steps = route.legs[0].steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepCoord = [step.maneuver.location[1], step.maneuver.location[0]];
      const icon = mapOSRMModifierToIcon(step.maneuver.type, step.maneuver.modifier);
      const streetName = step.name || "Road";
      
      let text = step.maneuver.instruction;
      if (!text) {
        if (step.maneuver.type === "depart") {
          text = `Depart towards ${streetName}`;
        } else if (step.maneuver.type === "arrive") {
          text = "You have arrived at your destination";
        } else if (step.maneuver.modifier) {
          text = `Turn ${step.maneuver.modifier} onto ${streetName}`;
        } else {
          text = `Continue onto ${streetName}`;
        }
      }

      // Find exact coordinate index in the route polyline array
      let closestCoordIdx = 0;
      let minD = Infinity;
      for (let c = 0; c < coords.length; c++) {
        const d = haversine(
          { lat: stepCoord[0], lon: stepCoord[1] },
          { lat: coords[c][0], lon: coords[c][1] }
        );
        if (d < minD) {
          minD = d;
          closestCoordIdx = c;
        }
      }

      instructions.push({
        maneuver: step.maneuver.type || "turn",
        icon,
        text,
        streetName,
        distanceM: Math.round(step.distance),
        coord: stepCoord,
        pathIndex: closestCoordIdx,
      });

      accumulatedDist += step.distance;
    }
  }

  // Ensure first instruction is depart and last is arrive
  if (instructions.length === 0) {
    instructions.push({
      maneuver: "depart",
      icon: "🚀",
      text: "Start navigation",
      streetName: "Route",
      distanceM: 0,
      coord: coords[0],
      pathIndex: 0,
    });
    instructions.push({
      maneuver: "arrive",
      icon: "🏁",
      text: "You have arrived at your destination",
      streetName: "Destination",
      distanceM: Math.round(route.distance),
      coord: coords[coords.length - 1],
      pathIndex: coords.length - 1,
    });
  }

  return {
    path,
    coords,
    distance: distanceKm,
    time: timeMin,
    instructions,
  };
}


// ─── Build Smart Corridor Graph from a Planned Route ────────
export function buildCorridorGraph(routeResult) {
  const { coords, path } = routeResult;
  const nodes = {};
  const graph = {};
  const edgeMeta = {};

  if (!coords || coords.length < 2) {
    return { graph, nodes, edgeMeta };
  }

  // 1. Add all route nodes
  for (let i = 0; i < coords.length; i++) {
    const id = path && path[i] ? String(path[i]) : `corridor_node_${i}`;
    nodes[id] = { lat: coords[i][0], lon: coords[i][1] };
    graph[id] = [];
  }

  // 2. Connect route nodes with primary edges
  for (let i = 0; i < coords.length - 1; i++) {
    const from = path && path[i] ? String(path[i]) : `corridor_node_${i}`;
    const to = path && path[i + 1] ? String(path[i + 1]) : `corridor_node_${i + 1}`;

    const dist = haversine(nodes[from], nodes[to]);
    const speed = 60;
    const timeCost = dist / speed;
    const name = "Main Highway";

    graph[from].push({ node: to, distance: dist, timeCost, speed, highway: "primary", name });
    graph[to].push({ node: from, distance: dist, timeCost, speed, highway: "primary", name });
    edgeMeta[`${from}-${to}`] = { name, highway: "primary", speed, oneWay: false };
    edgeMeta[`${to}-${from}`] = { name, highway: "primary", speed, oneWay: false };
  }

  // 3. Add parallel detour nodes & edges
  const stepInterval = Math.max(2, Math.floor(coords.length / 20));
  let prevDetour = null;

  for (let i = 0; i < coords.length; i += stepInterval) {
    const mainId = path && path[i] ? String(path[i]) : `corridor_node_${i}`;
    const detourId = `detour_${i}`;
    const lat = coords[i][0] + 0.002;
    const lon = coords[i][1] + 0.002;

    nodes[detourId] = { lat, lon };
    graph[detourId] = [];

    const distToMain = haversine(nodes[mainId], nodes[detourId]);
    const speed = 40;
    const time = distToMain / speed;

    graph[mainId].push({ node: detourId, distance: distToMain, timeCost: time, speed, highway: "secondary", name: "Service Rd" });
    graph[detourId].push({ node: mainId, distance: distToMain, timeCost: time, speed, highway: "secondary", name: "Service Rd" });
    edgeMeta[`${mainId}-${detourId}`] = { name: "Service Rd", highway: "secondary", speed, oneWay: false };
    edgeMeta[`${detourId}-${mainId}`] = { name: "Service Rd", highway: "secondary", speed, oneWay: false };

    if (prevDetour) {
      const distSeg = haversine(nodes[prevDetour], nodes[detourId]);
      graph[prevDetour].push({ node: detourId, distance: distSeg, timeCost: distSeg / speed, speed, highway: "secondary", name: "Corridor Bypass" });
      graph[detourId].push({ node: prevDetour, distance: distSeg, timeCost: distSeg / speed, speed, highway: "secondary", name: "Corridor Bypass" });
      edgeMeta[`${prevDetour}-${detourId}`] = { name: "Corridor Bypass", highway: "secondary", speed, oneWay: false };
      edgeMeta[`${detourId}-${prevDetour}`] = { name: "Corridor Bypass", highway: "secondary", speed, oneWay: false };
    }

    prevDetour = detourId;
  }

  return { graph, nodes, edgeMeta };
}


// ─── Build graph from raw OSM elements ─────────────────────
function buildGraph(elements) {
  const nodes = {};
  const graph = {};
  const edgeMeta = {};

  for (const el of elements) {
    if (el.type === "node") {
      const id = String(el.id);
      nodes[id] = { lat: el.lat, lon: el.lon };
      graph[id] = [];
    }
  }

  for (const el of elements) {
    if (el.type !== "way" || !el.nodes) continue;

    const highway = el.tags?.highway || "unclassified";
    const speed = SPEED_LIMITS[highway] || 30;
    const name = el.tags?.name || highway;
    const oneWay = el.tags?.oneway === "yes";

    const wayNodes = el.nodes;

    for (let i = 0; i < wayNodes.length - 1; i++) {
      const from = String(wayNodes[i]);
      const to = String(wayNodes[i + 1]);

      if (!nodes[from] || !nodes[to]) continue;

      const dist = haversine(nodes[from], nodes[to]);
      const timeCost = dist / speed;

      const edgeData = {
        node: to,
        distance: dist,
        timeCost,
        speed,
        highway,
        name,
      };

      if (!graph[from]) graph[from] = [];
      graph[from].push(edgeData);

      edgeMeta[`${from}-${to}`] = { name, highway, speed, oneWay };

      if (!oneWay) {
        if (!graph[to]) graph[to] = [];
        graph[to].push({
          ...edgeData,
          node: from,
        });
        edgeMeta[`${to}-${from}`] = { name, highway, speed, oneWay: false };
      }
    }
  }

  return { graph, nodes, edgeMeta };
}


// ─── Fetch from Overpass API (for local bounded areas) ────
export async function fetchRoadNetwork(south, west, north, east) {
  const query = `
    [out:json][timeout:25];
    (
      way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"]
        (${south},${west},${north},${east});
    );
    out body;
    >;
    out skel qt;
  `;

  const response = await fetch(
    "https://overpass-api.de/api/interpreter",
    { method: "POST", body: query }
  );

  if (!response.ok) {
    throw new Error(`Overpass API error: ${response.status}`);
  }

  const data = await response.json();
  return buildGraph(data.elements);
}


// ─── Find nearest node to a coordinate ───────────────────
export function findNearestNode(nodes, lat, lon) {
  let nearest = null;
  let minDist = Infinity;

  for (const id in nodes) {
    const d = haversine({ lat, lon }, nodes[id]);
    if (d < minDist) {
      minDist = d;
      nearest = id;
    }
  }

  return { nodeId: nearest, distance: minDist };
}


// ─── Built-in fallback dataset: Vijayawada core grid ─────
export function getBuiltinNetwork(presetName = "vijayawada") {
  const presets = {
    vijayawada: generateGridNetwork(
      16.505, 80.640,
      16.530, 80.670,
      12, 12,
      "Vijayawada"
    ),
  };

  return presets[presetName] || presets.vijayawada;
}


// ─── Procedural grid network generator ───────────────────
function generateGridNetwork(
  southLat, westLon,
  northLat, eastLon,
  rows, cols,
  cityName
) {
  const nodes = {};
  const graph = {};
  const edgeMeta = {};
  const nodeIds = [];

  const latStep = (northLat - southLat) / (rows - 1);
  const lonStep = (eastLon - westLon) / (cols - 1);

  const nsStreets = [
    "MG Road", "Gandhi Nagar Rd", "Bandar Rd", "Eluru Rd",
    "Canal Rd", "NH-65", "Ring Rd", "Station Rd",
    "Benz Circle Rd", "Auto Nagar Rd", "KR Puram Rd", "Temple St"
  ];
  const ewStreets = [
    "1st Cross", "2nd Cross", "3rd Cross", "4th Cross",
    "5th Cross", "6th Cross", "7th Cross", "8th Cross",
    "9th Cross", "10th Cross", "11th Cross", "12th Cross"
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `${cityName}_${r}_${c}`;
      const lat = southLat + r * latStep;
      const lon = westLon + c * lonStep;

      nodes[id] = { lat, lon };
      graph[id] = [];
      nodeIds.push(id);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const from = `${cityName}_${r}_${c}`;
      const to = `${cityName}_${r}_${c + 1}`;
      const dist = haversine(nodes[from], nodes[to]);

      const highway = r === 0 || r === rows - 1 ? "primary" : "residential";
      const speed = SPEED_LIMITS[highway];
      const name = ewStreets[r] || `${r + 1}th Cross`;

      graph[from].push({ node: to, distance: dist, timeCost: dist / speed, speed, highway, name });
      graph[to].push({ node: from, distance: dist, timeCost: dist / speed, speed, highway, name });
      edgeMeta[`${from}-${to}`] = { name, highway, speed, oneWay: false };
      edgeMeta[`${to}-${from}`] = { name, highway, speed, oneWay: false };
    }
  }

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows - 1; r++) {
      const from = `${cityName}_${r}_${c}`;
      const to = `${cityName}_${r + 1}_${c}`;
      const dist = haversine(nodes[from], nodes[to]);

      const highway = c === 0 || c === cols - 1 ? "secondary" : "tertiary";
      const speed = SPEED_LIMITS[highway];
      const name = nsStreets[c] || `Road ${c + 1}`;

      graph[from].push({ node: to, distance: dist, timeCost: dist / speed, speed, highway, name });
      graph[to].push({ node: from, distance: dist, timeCost: dist / speed, speed, highway, name });
      edgeMeta[`${from}-${to}`] = { name, highway, speed, oneWay: false };
      edgeMeta[`${to}-${from}`] = { name, highway, speed, oneWay: false };
    }
  }

  for (let r = 0; r < rows - 2; r += 3) {
    for (let c = 0; c < cols - 2; c += 3) {
      const from = `${cityName}_${r}_${c}`;
      const to = `${cityName}_${r + 2}_${c + 2}`;
      const dist = haversine(nodes[from], nodes[to]);
      const speed = 35;

      graph[from].push({ node: to, distance: dist, timeCost: dist / speed, speed, highway: "tertiary", name: "Diagonal Bypass" });
      graph[to].push({ node: from, distance: dist, timeCost: dist / speed, speed, highway: "tertiary", name: "Diagonal Bypass" });
      edgeMeta[`${from}-${to}`] = { name: "Diagonal Bypass", highway: "tertiary", speed, oneWay: false };
      edgeMeta[`${to}-${from}`] = { name: "Diagonal Bypass", highway: "tertiary", speed, oneWay: false };
    }
  }

  return { graph, nodes, edgeMeta };
}
