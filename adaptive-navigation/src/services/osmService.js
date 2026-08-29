/**
 * OpenStreetMap Data Service
 * 
 * Fetches road network data from the Overpass API and builds
 * an adjacency-list graph. Includes built-in fallback datasets
 * for immediate offline functionality.
 */

// ─── Haversine distance (km) ───────────────────────────────
export function haversine(a, b) {
  const R = 6371;
  const toRad = (deg) => deg * Math.PI / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

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
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}


// ─── Speed limits by highway type (km/h) ──────────────────
const SPEED_LIMITS = {
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


// ─── Build graph from OSM elements ────────────────────────
function buildGraph(elements) {
  const nodes = {};
  const graph = {};
  const edgeMeta = {};  // edge metadata: "from-to" → {name, type, speed, oneWay}

  // 1. Collect all node coordinates
  for (const el of elements) {
    if (el.type === "node") {
      const id = String(el.id);
      nodes[id] = { lat: el.lat, lon: el.lon };
      graph[id] = [];
    }
  }

  // 2. Build edges from ways
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
      const timeCost = dist / speed;  // hours

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

      // Reverse edge (unless one-way)
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


// ─── Fetch from Overpass API ──────────────────────────────
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


// ─── Compute corridor bounding box around a route ─────────
export function computeCorridorBBox(routeCoords, bufferKm = 2) {
  if (!routeCoords || routeCoords.length === 0) return null;

  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  for (const [lat, lon] of routeCoords) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }

  // Convert buffer km to approximate degrees
  const latBuffer = bufferKm / 111.32;
  const lonBuffer = bufferKm / (111.32 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180));

  return {
    south: minLat - latBuffer,
    west: minLon - lonBuffer,
    north: maxLat + latBuffer,
    east: maxLon + lonBuffer,
  };
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
      16.505, 80.640,   // SW corner
      16.530, 80.670,   // NE corner
      12, 12,           // grid density
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

  // Streets names
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

  // Create nodes in a grid
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

  // Build horizontal edges (east-west streets)
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

  // Build vertical edges (north-south streets)
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

  // Add some diagonal shortcuts for realism
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


// ─── Merge two road networks ─────────────────────────────
export function mergeNetworks(net1, net2) {
  const nodes = { ...net1.nodes, ...net2.nodes };
  const graph = {};
  const edgeMeta = { ...net1.edgeMeta, ...net2.edgeMeta };

  // Combine adjacency lists
  for (const id in net1.graph) {
    graph[id] = [...(net1.graph[id] || [])];
  }
  for (const id in net2.graph) {
    graph[id] = [...(graph[id] || []), ...(net2.graph[id] || [])];
  }

  return { graph, nodes, edgeMeta };
}
