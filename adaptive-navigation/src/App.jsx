import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  CircleMarker,
  Popup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

// Services
import { getBuiltinNetwork, fetchRoadNetwork, findNearestNode, haversine } from "./services/osmService.js";
import { RoadGraph } from "./models/RoadGraph.js";
import { CacheManager } from "./services/cacheManager.js";
import { aStar } from "./algorithms/astar.js";
import {
  generateInstructions,
  findPositionOnRoute,
  isOffRoute,
  getNextInstruction,
  remainingDistance,
  computeETA,
} from "./services/navigationEngine.js";
import { GPSSimulator } from "./services/gpsSimulator.js";
import { NetworkMonitor, NET_STATE } from "./services/networkMonitor.js";


// ── Fix default Leaflet marker icons ─────────────────────
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
});


// ── Custom marker icons ──────────────────────────────────
const startIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:32px;height:32px;border-radius:50%;
    background:linear-gradient(135deg,#22c55e,#16a34a);
    border:3px solid white;
    box-shadow:0 2px 8px rgba(34,197,94,0.5);
    display:flex;align-items:center;justify-content:center;
    font-size:14px;color:white;font-weight:bold;
  ">A</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

const destIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:32px;height:32px;border-radius:50%;
    background:linear-gradient(135deg,#ef4444,#dc2626);
    border:3px solid white;
    box-shadow:0 2px 8px rgba(239,68,68,0.5);
    display:flex;align-items:center;justify-content:center;
    font-size:14px;color:white;font-weight:bold;
  ">B</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

function createVehicleIcon(strayed) {
  return L.divIcon({
    className: "",
    html: `
      <div style="position:relative;width:26px;height:26px;">
        <div class="vehicle-pulse"></div>
        <div class="vehicle-marker ${strayed ? "vehicle-marker--strayed" : ""}"
             style="position:absolute;top:3px;left:3px;"></div>
      </div>
    `,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}


// ── Map view controller ──────────────────────────────────
function MapViewController({ center, zoom, vehiclePos, followVehicle }) {
  const map = useMap();
  const initialSet = useRef(false);

  useEffect(() => {
    if (vehiclePos && followVehicle) {
      map.panTo([vehiclePos.lat, vehiclePos.lon], { animate: true, duration: 0.3 });
    } else if (center) {
      map.setView(center, zoom || map.getZoom(), { animate: initialSet.current });
      initialSet.current = true;
    }
  }, [center, zoom, vehiclePos, followVehicle, map]);

  return null;
}


// ── Map click handler ────────────────────────────────────
function MapClickHandler({ onMapClick, pickingMode, onUserDrag }) {
  useMapEvents({
    click(e) {
      if (pickingMode) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
    dragstart() {
      if (onUserDrag) onUserDrag();
    },
  });

  // Change cursor when in picking mode
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (pickingMode) {
      container.style.cursor = "crosshair";
    } else {
      container.style.cursor = "";
    }
    return () => { container.style.cursor = ""; };
  }, [pickingMode, map]);

  return null;
}


// Default map center: Vijayawada
const DEFAULT_CENTER = [16.515, 80.655];
const DEFAULT_ZOOM = 15;


// ══════════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════════

function App() {
  // ── Core state ──────────────────────────────────────────
  const [roadGraph, setRoadGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState("Initializing road network…");

  // ── Location picking state ─────────────────────────────
  // pickingMode: null | "start" | "destination"
  const [pickingMode, setPickingMode] = useState(null);
  const [startPoint, setStartPoint] = useState(null);   // { lat, lon }
  const [destPoint, setDestPoint] = useState(null);      // { lat, lon }

  // ── Route state ─────────────────────────────────────────
  const [routeResult, setRouteResult] = useState(null);
  const [instructions, setInstructions] = useState([]);
  const [rerouteResult, setRerouteResult] = useState(null);

  // ── Navigation / GPS state ─────────────────────────────
  const [vehiclePos, setVehiclePos] = useState(null);
  const [simRunning, setSimRunning] = useState(false);
  const [simSpeed, setSimSpeed] = useState(1);
  const [offRouteInfo, setOffRouteInfo] = useState(null);
  const [currentInstr, setCurrentInstr] = useState(null);
  const [eta, setEta] = useState("--");
  const [distRemaining, setDistRemaining] = useState(0);

  // ── Network state ──────────────────────────────────────
  const [netInfo, setNetInfo] = useState({
    state: NET_STATE.ONLINE,
    isOnline: true,
    isOffline: false,
    label: "Online",
    color: "#22c55e",
  });

  // ── Cache state ────────────────────────────────────────
  const [cacheInfo, setCacheInfo] = useState(CacheManager.getDisplayInfo());

  // ── UI state ───────────────────────────────────────────
  const [showGraphOverlay, setShowGraphOverlay] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [rerouteLog, setRerouteLog] = useState([]);
  const [panelOpen, setPanelOpen] = useState({
    simulation: true,
    cache: false,
    log: false,
  });
  const [mapViewCenter, setMapViewCenter] = useState(DEFAULT_CENTER);
  const [mapViewZoom, setMapViewZoom] = useState(DEFAULT_ZOOM);
  const [followVehicle, setFollowVehicle] = useState(true);

  // ── Refs ───────────────────────────────────────────────
  const gpsRef = useRef(null);
  const netRef = useRef(null);
  const graphRef = useRef(null);


  // ── Reroute log helper ─────────────────────────────────
  function addLog(text, latencyMs) {
    const now = new Date();
    const time = now.toLocaleTimeString("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    setRerouteLog((prev) => [
      {
        id: Date.now(),
        time,
        text,
        latency: latencyMs !== null && latencyMs !== undefined
          ? `${latencyMs.toFixed(1)}ms`
          : null,
      },
      ...prev.slice(0, 19),
    ]);
  }


  // ── Initialize road network + services ─────────────────
  useEffect(() => {
    async function init() {
      setLoading(true);

      // Clear any stale cache that might cause issues
      let graph;

      // Try cache first
      const cached = CacheManager.load();
      if (cached && cached.nodes && Object.keys(cached.nodes).length > 10) {
        setLoadingMsg("Loading cached road data…");
        graph = new RoadGraph(cached);
      } else {
        setLoadingMsg("Building road network…");
        CacheManager.clear(); // clear bad cache
        const builtinData = getBuiltinNetwork("vijayawada");
        graph = new RoadGraph(builtinData);
      }

      graphRef.current = graph;
      setRoadGraph(graph);

      // Save to cache
      CacheManager.save(graph);
      setCacheInfo(CacheManager.getDisplayInfo());

      // Set map to center on the graph's bounding box
      const bbox = graph.boundingBox;
      const center = [
        (bbox.south + bbox.north) / 2,
        (bbox.west + bbox.east) / 2,
      ];
      setMapViewCenter(center);
      setMapViewZoom(DEFAULT_ZOOM);

      // Init network monitor
      const monitor = new NetworkMonitor();
      netRef.current = monitor;
      setNetInfo(monitor.getInfo());
      monitor.onChange((info) => setNetInfo(info));

      // Init GPS simulator
      const gps = new GPSSimulator();
      gpsRef.current = gps;

      // Try live fetch in background (non-blocking)
      tryLiveFetch(graph);

      setLoading(false);
    }

    init();

    return () => {
      gpsRef.current?.destroy();
      netRef.current?.destroy();
    };
  }, []);


  // ── Live OSM fetch (background, non-blocking) ─────────
  async function tryLiveFetch(existingGraph) {
    try {
      const bbox = existingGraph.boundingBox;
      const liveData = await fetchRoadNetwork(
        bbox.south, bbox.west, bbox.north, bbox.east
      );
      const liveGraph = new RoadGraph(liveData);

      if (liveGraph.nodeCount > existingGraph.nodeCount) {
        graphRef.current = liveGraph;
        setRoadGraph(liveGraph);
        CacheManager.save(liveGraph);
        setCacheInfo(CacheManager.getDisplayInfo());
        addLog("🌐 Live OSM data loaded", null);
      }
    } catch {
      // Silently fail — we have the built-in data
    }
  }


  // ── Map click handler ──────────────────────────────────
  function handleMapClick(lat, lon) {
    if (pickingMode === "start") {
      setStartPoint({ lat, lon });
      setPickingMode("destination");
      addLog(`📌 Start point set`, null);
    } else if (pickingMode === "destination") {
      setDestPoint({ lat, lon });
      setPickingMode(null);
      addLog(`📌 Destination set`, null);
    }
  }


  // ── Auto-compute route when both points are set ────────
  useEffect(() => {
    if (!startPoint || !destPoint || !graphRef.current) return;

    async function calculateRoute() {
      let graph = graphRef.current;
      const dist = haversine(startPoint, destPoint);

      // Check if points are outside current graph's bounding box
      const bbox = graph.boundingBox;
      const isOutsideCurrentGraph =
        startPoint.lat < bbox.south - 0.05 || startPoint.lat > bbox.north + 0.05 ||
        startPoint.lon < bbox.west - 0.05 || startPoint.lon > bbox.east + 0.05 ||
        destPoint.lat < bbox.south - 0.05 || destPoint.lat > bbox.north + 0.05 ||
        destPoint.lon < bbox.west - 0.05 || destPoint.lon > bbox.east + 0.05;

      if (isOutsideCurrentGraph) {
        if (netInfo.isOnline) {
          if (dist > 15) {
            addLog("⚠️ Points too far apart for local download (Max 15km)", null);
            alert("Selected points are too far apart to download local road data (Max 15km). Please select points closer to each other.");
            return;
          }

          try {
            setLoading(true);
            setLoadingMsg("Downloading local road network for this area…");
            
            // Compute bounding box containing both points + 1.5km buffer
            const minLat = Math.min(startPoint.lat, destPoint.lat);
            const maxLat = Math.max(startPoint.lat, destPoint.lat);
            const minLon = Math.min(startPoint.lon, destPoint.lon);
            const maxLon = Math.max(startPoint.lon, destPoint.lon);
            
            const latBuf = 1.5 / 111.32;
            const lonBuf = 1.5 / (111.32 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
            
            const liveData = await fetchRoadNetwork(
              minLat - latBuf,
              minLon - lonBuf,
              maxLat + latBuf,
              maxLon + lonBuf
            );
            
            const newGraph = new RoadGraph(liveData);
            graphRef.current = newGraph;
            setRoadGraph(newGraph);
            CacheManager.save(newGraph);
            setCacheInfo(CacheManager.getDisplayInfo());
            graph = newGraph;
            addLog(`🌐 Downloaded road network for new area`, null);
          } catch (err) {
            console.error(err);
            addLog("⚠️ Failed to download road network", null);
            alert("Could not download road network for this area. Please try again or select points inside the cached Vijayawada area.");
            setLoading(false);
            return;
          } finally {
            setLoading(false);
          }
        } else {
          addLog("⚠️ Offline: Points outside cached area", null);
          alert("You are offline. Please select points inside the cached area (Vijayawada) or click 'Zoom to Cached Area'.");
          return;
        }
      }

      const startResult = findNearestNode(graph.nodes, startPoint.lat, startPoint.lon);
      const goalResult = findNearestNode(graph.nodes, destPoint.lat, destPoint.lon);

      if (!startResult.nodeId || !goalResult.nodeId) {
        addLog("⚠️ Points are outside the road network", null);
        return;
      }

      // Check if snapped distance is unreasonably far from clicked point
      if (startResult.distance > 2 || goalResult.distance > 2) {
        addLog("⚠️ Snapped point too far from road network", null);
        return;
      }

      const t0 = performance.now();
      const result = aStar(graph, startResult.nodeId, goalResult.nodeId);
      const elapsed = performance.now() - t0;

      if (result) {
        // Reset any previous simulation state
        if (gpsRef.current) {
          gpsRef.current.setRoute(result.coords);
          gpsRef.current.reset();
        }
        setSimRunning(false);
        setVehiclePos(null);
        setOffRouteInfo(null);
        setRerouteResult(null);

        setRouteResult(result);
        const instrs = generateInstructions(result, graph);
        setInstructions(instrs);
        const firstTurn = instrs.find(ins => ins.maneuver !== "depart") || instrs[0];
        setCurrentInstr(firstTurn || null);
        setDistRemaining(result.distance);
        setEta(computeETA(result.distance));
        addLog(`📍 Route: ${result.distance} km, ${result.path.length} nodes`, elapsed);
      } else {
        addLog("⚠️ No route found between these points", elapsed);
      }
    }

    calculateRoute();
  }, [startPoint, destPoint, netInfo.isOnline]);


  // ── Quick Route (auto pick SW→NE corners) ──────────────
  function handleQuickRoute() {
    const graph = graphRef.current;
    if (!graph) return;

    const bbox = graph.boundingBox;
    const sLat = bbox.south + (bbox.north - bbox.south) * 0.12;
    const sLon = bbox.west + (bbox.east - bbox.west) * 0.12;
    const dLat = bbox.north - (bbox.north - bbox.south) * 0.12;
    const dLon = bbox.east - (bbox.east - bbox.west) * 0.12;

    const center = [
      (bbox.south + bbox.north) / 2,
      (bbox.west + bbox.east) / 2,
    ];
    setMapViewCenter(center);
    setMapViewZoom(DEFAULT_ZOOM);

    setStartPoint({ lat: sLat, lon: sLon });
    setDestPoint({ lat: dLat, lon: dLon });
  }

  function handleCenterOnCached() {
    const graph = graphRef.current;
    if (graph) {
      const bbox = graph.boundingBox;
      const center = [
        (bbox.south + bbox.north) / 2,
        (bbox.west + bbox.east) / 2,
      ];
      setMapViewCenter(center);
      setMapViewZoom(DEFAULT_ZOOM);
      addLog("🔍 Map centered on cached area", null);
    } else {
      setMapViewCenter(DEFAULT_CENTER);
      setMapViewZoom(DEFAULT_ZOOM);
    }
  }


  // ── Reroute from current position ──────────────────────
  const reroute = useCallback((lat, lon) => {
    const graph = graphRef.current;
    if (!graph) return;

    const startResult = findNearestNode(graph.nodes, lat, lon);
    const origRoute = routeResult;
    if (!origRoute || origRoute.path.length === 0) return;

    const goalId = origRoute.path[origRoute.path.length - 1];

    const t0 = performance.now();
    const newRoute = aStar(graph, startResult.nodeId, goalId);
    const elapsed = performance.now() - t0;

    if (newRoute) {
      setRerouteResult(newRoute);
      const newInstrs = generateInstructions(newRoute, graph);
      setInstructions(newInstrs);
      setCurrentInstr(newInstrs[0] || null);

      addLog(
        netInfo.isOffline ? "🔴 Offline reroute" : "🔄 Online reroute",
        elapsed
      );

      if (gpsRef.current) {
        gpsRef.current.setRoute(newRoute.coords);
        gpsRef.current.returnToRoute();
        if (simRunning) gpsRef.current.start();
      }
    } else {
      addLog("⚠️ No alternate route found", elapsed);
    }
  }, [routeResult, netInfo.isOffline, simRunning]);


  // ── GPS position update handler ────────────────────────
  useEffect(() => {
    if (!gpsRef.current) return;

    const activeRoute = rerouteResult || routeResult;
    if (!activeRoute) return;

    const unsub = gpsRef.current.onPositionUpdate((pos) => {
      setVehiclePos(pos);

      const offInfo = isOffRoute(activeRoute.coords, pos.lat, pos.lon, 50);
      setOffRouteInfo(offInfo);

      if (offInfo.offRoute && pos.strayed) {
        reroute(pos.lat, pos.lon);
      }

      if (instructions.length > 0) {
        const nearest = findPositionOnRoute(activeRoute.coords, pos.lat, pos.lon);
        const next = getNextInstruction(instructions, nearest.index, [pos.lat, pos.lon]);
        setCurrentInstr(next);
        const remDist = remainingDistance(activeRoute.coords, nearest.index);
        setDistRemaining(remDist);
        setEta(computeETA(remDist, pos.speed || 35));
      }

      if (pos.finished) {
        setSimRunning(false);
      }
    });

    return unsub;
  }, [routeResult, rerouteResult, instructions, reroute]);


  // ── Online Reconnection & Present Location Sync ────────
  const prevOnlineRef = useRef(netInfo.isOnline);
  useEffect(() => {
    const wasOffline = !prevOnlineRef.current;
    const isNowOnline = netInfo.isOnline;
    prevOnlineRef.current = isNowOnline;

    if (wasOffline && isNowOnline) {
      addLog("🌐 Network restored: Refreshing route from present location", null);

      if (vehiclePos && (routeResult || rerouteResult)) {
        // Re-evaluate from present vehicle location
        reroute(vehiclePos.lat, vehiclePos.lon);
        setMapViewCenter([vehiclePos.lat, vehiclePos.lon]);
        setFollowVehicle(true);
      }
    }
  }, [netInfo.isOnline, vehiclePos, routeResult, rerouteResult, reroute]);


  function handleRecenterVehicle() {
    if (vehiclePos) {
      setMapViewCenter([vehiclePos.lat, vehiclePos.lon]);
      setFollowVehicle(true);
      addLog("🎯 Centered on present vehicle location", null);
    } else if (activeRoute?.coords?.[0]) {
      setMapViewCenter(activeRoute.coords[0]);
      setFollowVehicle(true);
      addLog("🎯 Centered on route start", null);
    }
  }


  // ── Simulation controls ────────────────────────────────
  function handleStartPause() {
    const gps = gpsRef.current;
    if (!gps) return;

    const activeRoute = rerouteResult || routeResult;
    if (!activeRoute) return;

    if (simRunning) {
      gps.pause();
      setSimRunning(false);
    } else {
      if (!gps.routeCoords.length) {
        gps.setRoute(activeRoute.coords);
      }
      gps.start();
      setSimRunning(true);
    }
  }

  function handleReset() {
    const gps = gpsRef.current;
    if (!gps) return;
    gps.reset();
    setSimRunning(false);
    setVehiclePos(null);
    setOffRouteInfo(null);
    setRerouteResult(null);

    if (routeResult && graphRef.current) {
      const instrs = generateInstructions(routeResult, graphRef.current);
      setInstructions(instrs);
      setCurrentInstr(instrs[0] || null);
      setDistRemaining(routeResult.distance);
      setEta(computeETA(routeResult.distance));
    }
  }

  function handleStray() {
    if (gpsRef.current) gpsRef.current.strayOffRoute();
  }

  function handleBlockRoad() {
    const graph = graphRef.current;
    const activeRoute = rerouteResult || routeResult;
    if (!graph || !activeRoute || !vehiclePos) return;

    const nearest = findPositionOnRoute(activeRoute.coords, vehiclePos.lat, vehiclePos.lon);
    const aheadIdx = Math.min(nearest.index + 3, activeRoute.path.length - 2);

    if (aheadIdx >= 0 && aheadIdx < activeRoute.path.length - 1) {
      const fromId = activeRoute.path[aheadIdx];
      const toId = activeRoute.path[aheadIdx + 1];
      graph.blockEdge(fromId, toId);
      addLog("🚧 Road blocked ahead", null);
      reroute(vehiclePos.lat, vehiclePos.lon);
    }
  }

  function handleSpeedChange(e) {
    const speed = Number(e.target.value);
    setSimSpeed(speed);
    if (gpsRef.current) gpsRef.current.setSpeed(speed);
  }

  function handleClearBlocks() {
    if (graphRef.current) {
      graphRef.current.clearAllBlocks();
      addLog("✅ All road blocks cleared", null);
    }
  }

  function handleClearRoute() {
    if (gpsRef.current) gpsRef.current.reset();
    setSimRunning(false);
    setVehiclePos(null);
    setOffRouteInfo(null);
    setRouteResult(null);
    setRerouteResult(null);
    setStartPoint(null);
    setDestPoint(null);
    setInstructions([]);
    setCurrentInstr(null);
    setDistRemaining(0);
    setEta("--");
  }

  function togglePanel(key) {
    setPanelOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }


  // ── Derived values ─────────────────────────────────────
  const activeRoute = rerouteResult || routeResult;

  const graphEdges = useMemo(() => {
    if (!showGraphOverlay || !roadGraph) return [];
    return roadGraph.getAllEdgesAsCoords();
  }, [showGraphOverlay, roadGraph]);

  // Determine picking step label
  const pickingLabel = pickingMode === "start"
    ? "👆 Click the map to set START point"
    : pickingMode === "destination"
      ? "👆 Click the map to set DESTINATION"
      : null;


  // ══════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════

  return (
    <div className="app">

      {/* ── Top Bar ──────────────────────────────────── */}
      <div className="top-bar">
        <div className="top-bar-left">
          <div className="logo">
            <span className="logo-icon">🧭</span>
            <span>Adaptive Nav</span>
            <span className="logo-badge">Beta</span>
          </div>
        </div>

        <div className="top-bar-right">
          {vehiclePos && (
            <button
              className="btn btn--primary btn--sm"
              onClick={handleRecenterVehicle}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              🎯 Recenter on Vehicle
            </button>
          )}

          <button
            className="btn btn--ghost btn--sm"
            onClick={handleCenterOnCached}
          >
            🔍 Zoom to Vijayawada
          </button>

          <button
            className="btn btn--ghost btn--sm"
            onClick={() => netRef.current?.toggleSimulation()}
          >
            {netInfo.isOffline ? "🌐 Restore" : "📡 Go Offline"}
          </button>

          <div className={`net-pill net-pill--${netInfo.state}`}>
            <span className="net-dot"></span>
            {netInfo.label}
          </div>
        </div>
      </div>


      {/* ── Map Area ─────────────────────────────────── */}
      <div className="map-wrapper">

        {/* Floating recenter button if user dragged map away from active vehicle */}
        {vehiclePos && !followVehicle && (
          <button
            className="recenter-float-btn"
            onClick={handleRecenterVehicle}
          >
            🎯 Recenter on Vehicle
          </button>
        )}

        {loading && (
          <div className="loading-overlay">
            <div className="loading-spinner"></div>
            <div className="loading-text">{loadingMsg}</div>
            <div className="loading-subtext">
              Building local road graph for offline navigation
            </div>
          </div>
        )}

        {/* Picking mode banner */}
        {pickingLabel && (
          <div className="picking-banner">
            <span>{pickingLabel}</span>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setPickingMode(null)}
              style={{ marginLeft: 12 }}
            >
              ✕ Cancel
            </button>
          </div>
        )}

        {/* Off-Route Alert */}
        {offRouteInfo?.offRoute && (
          <div className="offroute-alert">
            <span className="offroute-alert-icon">⚠️</span>
            <span>Off route — </span>
            <span className="rerouting-text">Rerouting…</span>
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              ({Math.round(offRouteInfo.distanceFromRoute)}m away)
            </span>
          </div>
        )}


        {!loading && (
          <MapContainer
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            className="map"
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            <MapViewController
              center={mapViewCenter}
              zoom={mapViewZoom}
              vehiclePos={vehiclePos}
              followVehicle={followVehicle}
            />
            <MapClickHandler
              onMapClick={handleMapClick}
              pickingMode={pickingMode}
              onUserDrag={() => setFollowVehicle(false)}
            />

            {/* Graph overlay */}
            {showGraphOverlay && graphEdges.map((edge, i) => (
              <Polyline
                key={`ge-${i}`}
                positions={[edge.from, edge.to]}
                pathOptions={{
                  color: edge.blocked ? "#ef4444" : "#3b82f640",
                  weight: edge.blocked ? 3 : 1,
                  dashArray: edge.blocked ? "6 4" : undefined,
                }}
              />
            ))}

            {/* Primary route */}
            {activeRoute && (
              <Polyline
                positions={activeRoute.coords}
                pathOptions={{
                  color: rerouteResult ? "#f59e0b" : "#3b82f6",
                  weight: 5,
                  opacity: 0.9,
                  lineCap: "round",
                  lineJoin: "round",
                }}
              />
            )}

            {/* Original route dimmed when rerouted */}
            {rerouteResult && routeResult && (
              <Polyline
                positions={routeResult.coords}
                pathOptions={{
                  color: "#64748b",
                  weight: 3,
                  opacity: 0.35,
                  dashArray: "8 6",
                }}
              />
            )}

            {/* Start marker */}
            {startPoint && (
              <Marker position={[startPoint.lat, startPoint.lon]} icon={startIcon}>
                <Popup><strong>🟢 Start</strong></Popup>
              </Marker>
            )}

            {/* Destination marker */}
            {destPoint && (
              <Marker position={[destPoint.lat, destPoint.lon]} icon={destIcon}>
                <Popup><strong>🏁 Destination</strong></Popup>
              </Marker>
            )}

            {/* Vehicle marker */}
            {vehiclePos && (
              <Marker
                position={[vehiclePos.lat, vehiclePos.lon]}
                icon={createVehicleIcon(vehiclePos.strayed)}
                zIndexOffset={1000}
              >
                <Popup>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12 }}>
                    <strong>🚗 Vehicle</strong><br />
                    Speed: {vehiclePos.speed} km/h<br />
                    Bearing: {Math.round(vehiclePos.bearing)}°
                    {vehiclePos.strayed && (
                      <><br /><span style={{ color: "#ef4444" }}>⚠️ Off Route</span></>
                    )}
                  </div>
                </Popup>
              </Marker>
            )}

            {/* Blocked road indicators */}
            {roadGraph && Array.from(roadGraph.blockedEdges).map((key) => {
              const [fromId] = key.split("-");
              const node = roadGraph.nodes[fromId];
              if (!node) return null;
              return (
                <CircleMarker
                  key={`block-${key}`}
                  center={[node.lat, node.lon]}
                  radius={6}
                  pathOptions={{
                    color: "#ef4444",
                    fillColor: "#ef4444",
                    fillOpacity: 0.7,
                    weight: 2,
                  }}
                >
                  <Popup>🚧 Road Blocked</Popup>
                </CircleMarker>
              );
            })}

          </MapContainer>
        )}


        {/* ── Route Picker Panel (top-left) ─────────── */}
        <div className="route-picker">
          <div className="panel-card">
            <div className="panel-card-header" style={{ cursor: "default" }}>
              <span className="panel-card-title">📍 Set Your Route</span>
            </div>
            <div className="panel-card-body">

              {/* Start point row */}
              <div className="route-point-row">
                <div className="route-point-dot route-point-dot--start"></div>
                <div className="route-point-info">
                  {startPoint
                    ? <span className="route-point-coords">{startPoint.lat.toFixed(4)}, {startPoint.lon.toFixed(4)}</span>
                    : <span className="route-point-placeholder">Click to set start…</span>
                  }
                </div>
                <button
                  className={`btn btn--sm ${pickingMode === "start" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setPickingMode(pickingMode === "start" ? null : "start")}
                >
                  {pickingMode === "start" ? "Picking…" : "Set"}
                </button>
              </div>

              {/* Destination point row */}
              <div className="route-point-row">
                <div className="route-point-dot route-point-dot--dest"></div>
                <div className="route-point-info">
                  {destPoint
                    ? <span className="route-point-coords">{destPoint.lat.toFixed(4)}, {destPoint.lon.toFixed(4)}</span>
                    : <span className="route-point-placeholder">Click to set destination…</span>
                  }
                </div>
                <button
                  className={`btn btn--sm ${pickingMode === "destination" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setPickingMode(pickingMode === "destination" ? null : "destination")}
                >
                  {pickingMode === "destination" ? "Picking…" : "Set"}
                </button>
              </div>

              {/* Action buttons */}
              <div className="btn-group" style={{ marginTop: 4 }}>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={handleQuickRoute}
                >
                  ⚡ Quick Route
                </button>
                {activeRoute && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={handleClearRoute}
                  >
                    ✕ Clear
                  </button>
                )}
              </div>

              {/* Route info */}
              {activeRoute && (
                <div className="route-info-mini">
                  <span>🛣️ {activeRoute.distance} km</span>
                  <span>⏱️ {activeRoute.time} min</span>
                  <span>📊 {activeRoute.path.length} nodes</span>
                </div>
              )}
            </div>
          </div>
        </div>


        {/* ── Navigation HUD (bottom-left) ──────────── */}
        {activeRoute && !loading && (
          <div className="nav-hud">
            <div className="nav-hud-header">
              <div className="nav-maneuver-icon">
                {currentInstr?.icon || "⬆️"}
              </div>
              <div className="nav-maneuver-info">
                <div className="nav-maneuver-distance">
                  {currentInstr && currentInstr.distanceM !== undefined
                    ? currentInstr.distanceM > 999
                      ? `In ${(currentInstr.distanceM / 1000).toFixed(1)} km`
                      : `In ${currentInstr.distanceM} m`
                    : activeRoute.distance > 0
                      ? `In ${Math.round(activeRoute.distance * 1000)} m`
                      : "Ready"
                  }
                </div>
                <div className="nav-maneuver-text">
                  {currentInstr?.text || "Follow calculated route"}
                </div>
              </div>
            </div>

            <div className="nav-hud-body">
              <div className="nav-stat">
                <div className="nav-stat-value">
                  {distRemaining >= 1
                    ? `${distRemaining.toFixed(1)} km`
                    : distRemaining > 0
                      ? `${Math.round(distRemaining * 1000)} m`
                      : `${activeRoute.distance.toFixed(1)} km`
                  }
                </div>
                <div className="nav-stat-label">
                  Distance Left
                </div>
              </div>
              <div className="nav-stat-divider"></div>
              <div className="nav-stat">
                <div className="nav-stat-value">{eta !== "--" ? eta : computeETA(activeRoute.distance)}</div>
                <div className="nav-stat-label">Estimated Time</div>
              </div>
              <div className="nav-stat-divider"></div>
              <div className="nav-stat">
                <div className="nav-stat-value">
                  {vehiclePos ? `${vehiclePos.speed}` : "0"}
                </div>
                <div className="nav-stat-label">km/h</div>
              </div>
            </div>

            {/* Turn by turn expandable drawer */}
            <div className="nav-hud-directions-toggle">
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setShowSteps(!showSteps)}
                style={{ width: "100%", fontSize: 11, borderRadius: 0, borderLeft: "none", borderRight: "none" }}
              >
                {showSteps ? "▲ Hide Turn Directions" : `▼ View ${instructions.length} Directions`}
              </button>
            </div>

            {showSteps && instructions.length > 0 && (
              <div className="nav-hud-steps">
                {instructions.map((ins, idx) => (
                  <div key={idx} className="nav-hud-step-item">
                    <span className="step-icon">{ins.icon}</span>
                    <div className="step-text-wrap">
                      <span className="step-text">{ins.text}</span>
                      {ins.streetName && <span className="step-street">{ins.streetName}</span>}
                    </div>
                    <span className="step-dist">
                      {ins.distanceM > 999 ? `${(ins.distanceM / 1000).toFixed(1)} km` : `${ins.distanceM} m`}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="nav-hud-footer">
              <span
                className={`nav-mode-badge ${
                  netInfo.isOffline
                    ? "nav-mode-badge--offline"
                    : "nav-mode-badge--online"
                }`}
              >
                {netInfo.isOffline ? "Offline" : "Online"}
              </span>
              <span>
                {netInfo.isOffline
                  ? "Routing with cached graph"
                  : "Connected to network"
                }
              </span>
            </div>
          </div>
        )}


        {/* ── Control Panel (top-right) ─────────────── */}
        <div className="control-panel">

          {/* Simulation Controls */}
          <div className="panel-card">
            <div
              className="panel-card-header"
              onClick={() => togglePanel("simulation")}
            >
              <span className="panel-card-title">🎮 Simulation</span>
              <span className={`panel-card-toggle ${panelOpen.simulation ? "panel-card-toggle--open" : ""}`}>▾</span>
            </div>

            {panelOpen.simulation && (
              <div className="panel-card-body">
                <div className="btn-group">
                  <button
                    className={`btn ${simRunning ? "btn--danger" : "btn--primary"}`}
                    onClick={handleStartPause}
                    disabled={!activeRoute}
                  >
                    {simRunning ? "⏸ Pause" : "▶ Start"}
                  </button>
                  <button className="btn btn--ghost" onClick={handleReset}>
                    ↺ Reset
                  </button>
                </div>

                <div className="speed-control">
                  <span className="speed-label">Speed</span>
                  <input
                    type="range" className="speed-slider"
                    min="1" max="10" step="1"
                    value={simSpeed} onChange={handleSpeedChange}
                  />
                  <span className="speed-value">{simSpeed}x</span>
                </div>

                <div className="btn-group">
                  <button
                    className="btn btn--danger btn--sm"
                    onClick={handleStray} disabled={!simRunning}
                  >
                    ↗ Stray Off
                  </button>
                  <button
                    className="btn btn--danger btn--sm"
                    onClick={handleBlockRoad} disabled={!simRunning}
                  >
                    🚧 Block Road
                  </button>
                </div>

                <button
                  className="btn btn--ghost btn--sm"
                  onClick={handleClearBlocks}
                  style={{ width: "100%" }}
                >
                  ✅ Clear All Blocks
                </button>
              </div>
            )}
          </div>

          {/* Cache Inspector */}
          <div className="panel-card">
            <div className="panel-card-header" onClick={() => togglePanel("cache")}>
              <span className="panel-card-title">💾 Cache Inspector</span>
              <span className={`panel-card-toggle ${panelOpen.cache ? "panel-card-toggle--open" : ""}`}>▾</span>
            </div>

            {panelOpen.cache && (
              <div className="panel-card-body">
                <div className="cache-stats">
                  <div className="cache-stat">
                    <div className="cache-stat-value">{cacheInfo.nodes.toLocaleString()}</div>
                    <div className="cache-stat-label">Nodes</div>
                  </div>
                  <div className="cache-stat">
                    <div className="cache-stat-value">{cacheInfo.edges.toLocaleString()}</div>
                    <div className="cache-stat-label">Edges</div>
                  </div>
                  <div className="cache-stat">
                    <div className="cache-stat-value">{cacheInfo.sizeKB} KB</div>
                    <div className="cache-stat-label">Size</div>
                  </div>
                  <div className="cache-stat">
                    <div className="cache-stat-value">{cacheInfo.age || "—"}</div>
                    <div className="cache-stat-label">Cached</div>
                  </div>
                </div>

                <div className="toggle-row">
                  <span className="toggle-label">Show Graph Overlay</span>
                  <div
                    className={`toggle-switch ${showGraphOverlay ? "toggle-switch--active" : ""}`}
                    onClick={() => setShowGraphOverlay(!showGraphOverlay)}
                  ></div>
                </div>

                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    if (roadGraph) {
                      CacheManager.save(roadGraph);
                      setCacheInfo(CacheManager.getDisplayInfo());
                      addLog("💾 Cache updated", null);
                    }
                  }}
                  style={{ width: "100%" }}
                >
                  📥 Save to Cache
                </button>
              </div>
            )}
          </div>

          {/* Activity Log */}
          <div className="panel-card">
            <div className="panel-card-header" onClick={() => togglePanel("log")}>
              <span className="panel-card-title">📊 Activity Log</span>
              <span className={`panel-card-toggle ${panelOpen.log ? "panel-card-toggle--open" : ""}`}>▾</span>
            </div>

            {panelOpen.log && (
              <div className="panel-card-body">
                <div className="reroute-log">
                  {rerouteLog.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 8 }}>
                      No activity yet. Set a route and start simulation.
                    </div>
                  ) : (
                    rerouteLog.map((entry) => (
                      <div key={entry.id} className="log-entry">
                        <span className="log-time">{entry.time}</span>
                        <span className="log-text">{entry.text}</span>
                        {entry.latency && (
                          <span className="log-latency">{entry.latency}</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

        </div>
        {/* end control-panel */}

      </div>
      {/* end map-wrapper */}

    </div>
  );
}

export default App;