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

// Services & Models
import {
  findNearestNode,
  haversine,
  fetchGlobalRoute,
  buildCorridorGraph,
} from "./services/osmService.js";
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
import { RealGPSTracker } from "./services/realGpsService.js";
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
  html: `<div class="custom-marker marker-start">
    <span>A</span>
    <div class="marker-shadow"></div>
  </div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

const destIcon = L.divIcon({
  className: "",
  html: `<div class="custom-marker marker-dest">
    <span>B</span>
    <div class="marker-shadow"></div>
  </div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

function createVehicleIcon(strayed, heading = 0) {
  return L.divIcon({
    className: "",
    html: `
      <div class="vehicle-beacon-container" style="transform: rotate(${heading}deg);">
        <div class="vehicle-pulse-ring"></div>
        <div class="vehicle-core ${strayed ? "vehicle-core--strayed" : ""}">
          <div class="vehicle-heading-arrow"></div>
        </div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}


// ── Map view controller ──────────────────────────────────
function MapViewController({ center, zoom, vehiclePos, followVehicle }) {
  const map = useMap();
  const initialSet = useRef(false);

  useEffect(() => {
    if (vehiclePos && followVehicle) {
      map.panTo([vehiclePos.lat, vehiclePos.lon], { animate: true, duration: 0.4 });
    } else if (center) {
      map.setView(center, zoom || map.getZoom(), { animate: initialSet.current });
      initialSet.current = true;
    }
  }, [center, zoom, vehiclePos, followVehicle, map]);

  return null;
}


// ── Map click / drag handler ─────────────────────────────
function MapClickHandler({ onMapClick, pickingMode, onUserDrag }) {
  useMapEvents({
    click(e) {
      if (pickingMode && onMapClick) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
    dragstart() {
      if (onUserDrag) onUserDrag();
    },
  });

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


// Initial fallback center (Neutral Global View before GPS locks in)
const NEUTRAL_CENTER = [20.5937, 78.9629];
const NEUTRAL_ZOOM = 5;


// ══════════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════════

export default function App() {
  // ── Core state ──────────────────────────────────────────
  const [roadGraph, setRoadGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState("Acquiring GPS location…");

  // ── Location picking state ─────────────────────────────
  const [pickingMode, setPickingMode] = useState(null); // null | "start" | "destination"
  const [startPoint, setStartPoint] = useState(null);   // { lat, lon, isCurrentGps }
  const [destPoint, setDestPoint] = useState(null);      // { lat, lon }
  const [toastMsg, setToastMsg] = useState(null);

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
    color: "#10b981",
  });

  // ── Cache state ────────────────────────────────────────
  const [cacheInfo, setCacheInfo] = useState(CacheManager.getDisplayInfo());

  // ── UI state ───────────────────────────────────────────
  const [showGraphOverlay, setShowGraphOverlay] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [rerouteLog, setRerouteLog] = useState([]);
  const [panelOpen, setPanelOpen] = useState({
    tracking: true,
    cache: false,
    log: false,
  });
  const [mapViewCenter, setMapViewCenter] = useState(NEUTRAL_CENTER);
  const [mapViewZoom, setMapViewZoom] = useState(NEUTRAL_ZOOM);
  const [followVehicle, setFollowVehicle] = useState(true);
  const [gpsMode, setGpsMode] = useState("real"); // "real" | "simulation"

  // ── Refs ───────────────────────────────────────────────
  const gpsRef = useRef(null);
  const realGpsRef = useRef(null);
  const netRef = useRef(null);
  const graphRef = useRef(null);


  // ── Toast Helper ───────────────────────────────────────
  function showToast(text, duration = 3000) {
    setToastMsg(text);
    setTimeout(() => setToastMsg(null), duration);
  }

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


  // ── Initialize App & Auto-Detect User's Real GPS Location ─
  useEffect(() => {
    async function init() {
      setLoading(true);
      setLoadingMsg("Acquiring your live GPS location…");

      // Init network monitor
      const monitor = new NetworkMonitor();
      netRef.current = monitor;
      setNetInfo(monitor.getInfo());
      monitor.onChange((info) => setNetInfo(info));

      // Init GPS simulator & Real GPS Tracker
      const gps = new GPSSimulator();
      gpsRef.current = gps;
      const realGps = new RealGPSTracker();
      realGpsRef.current = realGps;

      // Load cached graph if previously saved
      const cached = CacheManager.load();
      if (cached && cached.nodes && Object.keys(cached.nodes).length > 5) {
        const restoredGraph = new RoadGraph(cached);
        graphRef.current = restoredGraph;
        setRoadGraph(restoredGraph);
      }

      // Automatically query user's physical GPS location on startup
      try {
        const userLoc = await realGps.getCurrentLocation();
        const userPoint = {
          lat: userLoc.lat,
          lon: userLoc.lon,
          isCurrentGps: true,
          accuracy: userLoc.accuracy,
        };

        setStartPoint(userPoint);
        setVehiclePos({
          lat: userLoc.lat,
          lon: userLoc.lon,
          speed: userLoc.speed || 0,
          bearing: 0,
          accuracy: userLoc.accuracy,
          isRealGps: true,
        });

        setMapViewCenter([userLoc.lat, userLoc.lon]);
        setMapViewZoom(15);
        setFollowVehicle(true);

        // Start live continuous background GPS streaming
        realGps.start();
        setGpsMode("real");
        addLog("🛰️ GPS Satellite Lock: Centered on your current location", null);
      } catch (err) {
        console.info("Location permission pending or not granted:", err.message);
        addLog("📍 Tap 'Current Location' to center on your position", null);
      } finally {
        setLoading(false);
      }
    }

    init();

    return () => {
      gpsRef.current?.destroy();
      realGpsRef.current?.destroy();
      netRef.current?.destroy();
    };
  }, []);


  // ── Map click handler ──────────────────────────────────
  function handleMapClick(lat, lon) {
    if (pickingMode === "start") {
      setStartPoint({ lat, lon, isCurrentGps: false });
      setPickingMode("destination");
      showToast("📍 Pickup set! Now tap destination point.");
      addLog("📌 Pickup point set on map", null);
    } else if (pickingMode === "destination") {
      setDestPoint({ lat, lon });
      setPickingMode(null);
      showToast("🏁 Destination set! Calculating route…");
      addLog("📌 Destination set on map", null);
    }
  }


  // ── Sample Highway Presets (Optional Demonstrations) ────
  const SAMPLE_HIGHWAY_ROUTES = [
    {
      id: "hubballi_ballari",
      label: "🛣️ Hubballi → Ballari (150 km)",
      start: { lat: 15.3647, lon: 75.1240 },
      dest: { lat: 15.1394, lon: 76.9214 },
    },
    {
      id: "hyderabad_vijayawada",
      label: "🚀 Hyderabad → Vijayawada (275 km)",
      start: { lat: 17.3850, lon: 78.4867 },
      dest: { lat: 16.5062, lon: 80.6480 },
    },
    {
      id: "bengaluru_tirupati",
      label: "🌲 Bengaluru → Tirupati (250 km)",
      start: { lat: 12.9716, lon: 77.5946 },
      dest: { lat: 13.6288, lon: 79.4192 },
    },
  ];

  function handleSelectSampleHighway(preset) {
    setStartPoint({ ...preset.start, isCurrentGps: false });
    setDestPoint(preset.dest);
    setMapViewCenter([
      (preset.start.lat + preset.dest.lat) / 2,
      (preset.start.lon + preset.dest.lon) / 2,
    ]);
    showToast(`Loaded route: ${preset.label}`);
  }


  // ── Compute route when Start and Dest are ready ─────────
  useEffect(() => {
    if (!startPoint || !destPoint) return;

    async function calculateRoute() {
      const t0 = performance.now();

      // 1. If Online: High-speed Global OSRM Routing (unlimited distance, sub-100ms)
      if (netInfo.isOnline) {
        try {
          const globalResult = await fetchGlobalRoute(
            startPoint.lat,
            startPoint.lon,
            destPoint.lat,
            destPoint.lon
          );

          const elapsed = performance.now() - t0;

          // Build Smart Corridor Graph along this route for offline A* resilience
          const corridorData = buildCorridorGraph(globalResult);
          const corridorGraph = new RoadGraph(corridorData);
          graphRef.current = corridorGraph;
          setRoadGraph(corridorGraph);

          // Save corridor graph to cache
          CacheManager.save(corridorGraph);
          setCacheInfo(CacheManager.getDisplayInfo());

          // Set Route Result & GPS track
          if (gpsRef.current) {
            gpsRef.current.setRoute(globalResult.coords);
          }
          setOffRouteInfo(null);
          setRerouteResult(null);

          setRouteResult(globalResult);
          setInstructions(globalResult.instructions);
          const firstTurn = globalResult.instructions.find((ins) => ins.maneuver !== "depart") || globalResult.instructions[0];
          setCurrentInstr(firstTurn || null);
          setDistRemaining(globalResult.distance);
          setEta(globalResult.time);

          // Fit map bounds to show full route
          let minLat = Infinity, maxLat = -Infinity;
          let minLon = Infinity, maxLon = -Infinity;
          for (let i = 0; i < globalResult.coords.length; i++) {
            const [cLat, cLon] = globalResult.coords[i];
            if (cLat < minLat) minLat = cLat;
            if (cLat > maxLat) maxLat = cLat;
            if (cLon < minLon) minLon = cLon;
            if (cLon > maxLon) maxLon = cLon;
          }
          setMapViewCenter([(minLat + maxLat) / 2, (minLon + maxLon) / 2]);

          addLog(`🌐 Smart Route: ${globalResult.distance} km, ${globalResult.coords.length} pts (Corridor cached)`, elapsed);
          return;
        } catch (err) {
          console.warn("Global routing failed, falling back to local road graph:", err);
        }
      }

      // 2. If Offline (or fallback): use local RoadGraph with A* pathfinding
      const graph = graphRef.current;
      if (!graph) return;

      const startResult = findNearestNode(graph.nodes, startPoint.lat, startPoint.lon);
      const goalResult = findNearestNode(graph.nodes, destPoint.lat, destPoint.lon);

      if (!startResult.nodeId || !goalResult.nodeId) {
        addLog("⚠️ Points outside cached road corridor (connect online for global routing)", null);
        return;
      }

      const result = aStar(graph, startResult.nodeId, goalResult.nodeId);
      const elapsed = performance.now() - t0;

      if (result) {
        if (gpsRef.current) {
          gpsRef.current.setRoute(result.coords);
        }
        setOffRouteInfo(null);
        setRerouteResult(null);

        setRouteResult(result);
        const instrs = generateInstructions(result, graph);
        setInstructions(instrs);
        const firstTurn = instrs.find((ins) => ins.maneuver !== "depart") || instrs[0];
        setCurrentInstr(firstTurn || null);
        setDistRemaining(result.distance);
        setEta(computeETA(result.distance));
        addLog(`📍 Offline A* Route: ${result.distance} km, ${result.path.length} nodes`, elapsed);
      } else {
        addLog("⚠️ No alternate path found in cached corridor", elapsed);
      }
    }

    calculateRoute();
  }, [startPoint, destPoint]);


  // ── Primary Action: Calculate / Start Navigation ────────
  async function handleStartNavigationAction() {
    if (!startPoint) {
      await handleUseCurrentLocation("start");
    }

    if (!destPoint) {
      setPickingMode("destination");
      showToast("👆 Tap anywhere on the map to set your Destination");
      return;
    }

    if (activeRoute) {
      if (gpsMode === "simulation") {
        handleStartPauseSim();
      } else {
        setFollowVehicle(true);
        if (vehiclePos) setMapViewCenter([vehiclePos.lat, vehiclePos.lon]);
        showToast("🛰️ Navigating with live GPS");
      }
    }
  }


  // ── Re-route logic (adaptive) ──────────────────────────
  const reroute = useCallback(
    async (lat, lon) => {
      const graph = graphRef.current;
      const origRoute = routeResult;
      if (!origRoute || !destPoint) return;

      const t0 = performance.now();

      // 1. If online: try high-speed OSRM reroute from present location to destination
      if (netInfo.isOnline) {
        try {
          const globalResult = await fetchGlobalRoute(lat, lon, destPoint.lat, destPoint.lon);
          const elapsed = performance.now() - t0;

          const corridorData = buildCorridorGraph(globalResult);
          const corridorGraph = new RoadGraph(corridorData);
          graphRef.current = corridorGraph;
          setRoadGraph(corridorGraph);

          setRerouteResult(globalResult);
          setInstructions(globalResult.instructions);
          const firstTurn = globalResult.instructions.find((ins) => ins.maneuver !== "depart") || globalResult.instructions[0];
          setCurrentInstr(firstTurn || null);
          setDistRemaining(globalResult.distance);
          setEta(globalResult.time);

          addLog(`🌐 Online Reroute: ${globalResult.distance} km`, elapsed);

          if (gpsRef.current) {
            gpsRef.current.setRoute(globalResult.coords);
            gpsRef.current.returnToRoute();
            if (simRunning) gpsRef.current.start();
          }
          return;
        } catch (err) {
          console.warn("Online reroute fallback to local graph:", err);
        }
      }

      // 2. Offline: use in-memory corridor/regional A*
      if (!graph) return;
      const startResult = findNearestNode(graph.nodes, lat, lon);
      const goalId = origRoute.path[origRoute.path.length - 1];

      const newRoute = aStar(graph, startResult.nodeId, goalId);
      const elapsed = performance.now() - t0;

      if (newRoute) {
        setRerouteResult(newRoute);
        const newInstrs = generateInstructions(newRoute, graph);
        setInstructions(newInstrs);
        setCurrentInstr(newInstrs[0] || null);

        addLog(
          netInfo.isOffline ? "🔴 Offline A* reroute (Corridor)" : "🔄 Local A* reroute",
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
    },
    [routeResult, destPoint, netInfo.isOffline, netInfo.isOnline, simRunning]
  );


  // ── Unified GPS position update handler (Simulation + Real GPS) ────
  useEffect(() => {
    const activeRoute = rerouteResult || routeResult;

    const handlePos = (pos) => {
      setVehiclePos(pos);

      if (activeRoute) {
        const offInfo = isOffRoute(activeRoute.coords, pos.lat, pos.lon, 50);
        setOffRouteInfo(offInfo);

        if (offInfo.offRoute && (pos.strayed || gpsMode === "real")) {
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
      }

      if (pos.finished) {
        setSimRunning(false);
      }
    };

    const unsubSim = gpsRef.current?.onPositionUpdate(handlePos);
    const unsubReal = realGpsRef.current?.onPositionUpdate(handlePos);

    return () => {
      if (unsubSim) unsubSim();
      if (unsubReal) unsubReal();
    };
  }, [routeResult, rerouteResult, instructions, reroute, gpsMode]);


  // ── Real Mobile GPS & Tracking handlers ────────────────
  async function handleToggleGpsMode(mode) {
    setGpsMode(mode);
    if (mode === "real") {
      gpsRef.current?.pause();
      setSimRunning(false);

      try {
        const currentLoc = await realGpsRef.current.getCurrentLocation();
        setStartPoint({ ...currentLoc, isCurrentGps: true });
        setMapViewCenter([currentLoc.lat, currentLoc.lon]);
        setFollowVehicle(true);
        realGpsRef.current.start();
        showToast("🛰️ Connected to Live Device GPS");
        addLog("🛰️ Real Device GPS tracking active", null);
      } catch (err) {
        showToast("⚠️ Location access required for Live GPS mode");
        setGpsMode("simulation");
      }
    } else {
      realGpsRef.current?.stop();
      showToast("🚗 Switched to Drive Simulator");
      addLog("🚗 Switched to Drive Simulator", null);
    }
  }

  async function handleUseCurrentLocation(pointType) {
    try {
      setLoading(true);
      setLoadingMsg("Locking onto your physical GPS satellite position…");
      const loc = await realGpsRef.current.getCurrentLocation();
      loc.isCurrentGps = true;

      setGpsMode("real");
      gpsRef.current?.pause();
      setSimRunning(false);
      realGpsRef.current.start();

      if (pointType === "start") {
        setStartPoint(loc);
        setVehiclePos({ ...loc, speed: loc.speed || 0, bearing: 0, isRealGps: true });
        showToast("📍 Pickup set to your live GPS location");
        addLog("🛰️ Pickup set to your live GPS coordinates", null);
      } else {
        setDestPoint(loc);
        showToast("🏁 Destination set to your live GPS location");
        addLog("🛰️ Destination set to your live GPS coordinates", null);
      }
      setMapViewCenter([loc.lat, loc.lon]);
      setMapViewZoom(16);
      setFollowVehicle(true);
    } catch {
      showToast("⚠️ Location permission required. Please allow access.");
    } finally {
      setLoading(false);
    }
  }


  // ── Online Reconnection & Present Location Sync ────────
  const prevOnlineRef = useRef(netInfo.isOnline);
  useEffect(() => {
    const wasOffline = !prevOnlineRef.current;
    const isNowOnline = netInfo.isOnline;
    prevOnlineRef.current = isNowOnline;

    if (wasOffline && isNowOnline) {
      addLog("🌐 Network restored: Refreshing route from present location", null);
      showToast("🌐 Connected online — Route refreshed");

      if (vehiclePos && destPoint) {
        reroute(vehiclePos.lat, vehiclePos.lon);
        setMapViewCenter([vehiclePos.lat, vehiclePos.lon]);
        setFollowVehicle(true);
      }
    }
  }, [netInfo.isOnline, vehiclePos, destPoint, reroute]);


  function handleRecenterVehicle() {
    if (vehiclePos) {
      setMapViewCenter([vehiclePos.lat, vehiclePos.lon]);
      setMapViewZoom(16);
      setFollowVehicle(true);
      showToast("🎯 Centered on your location");
      addLog("🎯 Centered on present vehicle location", null);
    } else if (startPoint) {
      setMapViewCenter([startPoint.lat, startPoint.lon]);
      setMapViewZoom(15);
      setFollowVehicle(true);
      showToast("🎯 Centered on start location");
    }
  }


  // ── Simulation controls ────────────────────────────────
  function handleStartPauseSim() {
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
      setGpsMode("simulation");
    }
  }

  function handleResetSim() {
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

    const nearest = findPositionOnRoute(
      activeRoute.coords,
      vehiclePos.lat,
      vehiclePos.lon
    );
    const aheadIdx = nearest.index + 1;
    if (aheadIdx < activeRoute.path.length - 1) {
      const fromId = activeRoute.path[aheadIdx];
      const toId = activeRoute.path[aheadIdx + 1];
      graph.blockEdge(fromId, toId);
      addLog("🚧 Road block simulated ahead", null);
      showToast("🚧 Road blocked ahead — Rerouting");
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
      showToast("✅ Road blocks cleared");
    }
  }

  function handleClearRoute() {
    if (gpsRef.current) gpsRef.current.reset();
    setSimRunning(false);
    setOffRouteInfo(null);
    setRouteResult(null);
    setRerouteResult(null);
    setDestPoint(null);
    setInstructions([]);
    setCurrentInstr(null);
    setDistRemaining(0);
    setEta("--");
    showToast("Route cleared");
  }

  function handleSwapPoints() {
    if (startPoint && destPoint) {
      const temp = startPoint;
      setStartPoint({ ...destPoint, isCurrentGps: false });
      setDestPoint(temp);
      showToast("⇄ Swapped Start and Destination");
    }
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

  const pickingLabel = pickingMode === "start"
    ? "👆 Tap map to set PICKUP point"
    : pickingMode === "destination"
      ? "👆 Tap map to set DESTINATION"
      : null;


  // ══════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════

  return (
    <div className="app">

      {/* ── Top Floating Header ───────────────────────── */}
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="logo">
            <div className="logo-icon-wrap">
              <span className="logo-icon">🧭</span>
            </div>
            <div className="logo-text">
              <span className="logo-title">Adaptive Nav</span>
              <span className="logo-subtitle">Smart Hybrid GPS</span>
            </div>
          </div>
        </div>

        <div className="top-bar-right">
          {/* Tracking Mode Pill */}
          <div className="gps-mode-switch">
            <button
              className={`mode-tab ${gpsMode === "real" ? "mode-tab--active" : ""}`}
              onClick={() => handleToggleGpsMode("real")}
            >
              🛰️ Live GPS
            </button>
            <button
              className={`mode-tab ${gpsMode === "simulation" ? "mode-tab--active" : ""}`}
              onClick={() => handleToggleGpsMode("simulation")}
            >
              🎮 Sim Drive
            </button>
          </div>

          {/* Network State Toggle Pill */}
          <button
            className="net-status-btn"
            onClick={() => netRef.current?.toggleSimulation()}
            title="Click to toggle Online/Offline simulation"
          >
            <span className={`net-status-dot net-status-dot--${netInfo.state}`}></span>
            <span className="net-status-label">{netInfo.isOffline ? "Offline (Corridor A*)" : "Online"}</span>
          </button>
        </div>
      </header>


      {/* ── Main Map Viewport ─────────────────────────── */}
      <main className="map-wrapper">

        {/* Global Toast Notification */}
        {toastMsg && (
          <div className="toast-banner">
            <span>{toastMsg}</span>
          </div>
        )}

        {/* Loading Overlay */}
        {loading && (
          <div className="loading-overlay">
            <div className="loading-spinner-ring"></div>
            <div className="loading-text">{loadingMsg}</div>
            <div className="loading-subtext">
              High-accuracy hybrid navigation engine
            </div>
          </div>
        )}

        {/* Picking Mode Banner */}
        {pickingLabel && (
          <div className="picking-banner">
            <span className="picking-banner-pulse"></span>
            <span>{pickingLabel}</span>
            <button
              className="picking-cancel-btn"
              onClick={() => setPickingMode(null)}
            >
              ✕ Cancel
            </button>
          </div>
        )}

        {/* Off-Route Dynamic Alert */}
        {offRouteInfo?.offRoute && (
          <div className="offroute-alert">
            <span className="offroute-alert-icon">⚡</span>
            <div>
              <strong>Off Route Detected</strong>
              <div style={{ fontSize: 11, opacity: 0.85 }}>
                Rerouting in {netInfo.isOffline ? "offline corridor A*" : "OSRM engine"}…
              </div>
            </div>
          </div>
        )}


        {/* Interactive Map */}
        {!loading && (
          <MapContainer
            center={mapViewCenter}
            zoom={mapViewZoom}
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

            {/* Road graph overlay */}
            {showGraphOverlay && graphEdges.map((edge, i) => (
              <Polyline
                key={`ge-${i}`}
                positions={[edge.from, edge.to]}
                pathOptions={{
                  color: edge.blocked ? "#f43f5e" : "rgba(59, 130, 246, 0.35)",
                  weight: edge.blocked ? 4 : 1.5,
                  dashArray: edge.blocked ? "6 4" : undefined,
                }}
              />
            ))}

            {/* Active Route Line */}
            {activeRoute && (
              <Polyline
                positions={activeRoute.coords}
                pathOptions={{
                  color: rerouteResult ? "#f59e0b" : "#3b82f6",
                  weight: 6,
                  opacity: 0.95,
                  lineCap: "round",
                  lineJoin: "round",
                }}
              />
            )}

            {/* Start marker */}
            {startPoint && (
              <Marker position={[startPoint.lat, startPoint.lon]} icon={startIcon}>
                <Popup>
                  <div className="map-popup-card">
                    <strong>🟢 Pickup Location</strong>
                    <div>{startPoint.isCurrentGps ? "Your live GPS position" : `${startPoint.lat.toFixed(4)}, ${startPoint.lon.toFixed(4)}`}</div>
                  </div>
                </Popup>
              </Marker>
            )}

            {/* Destination marker */}
            {destPoint && (
              <Marker position={[destPoint.lat, destPoint.lon]} icon={destIcon}>
                <Popup>
                  <div className="map-popup-card">
                    <strong>🏁 Destination</strong>
                    <div>{destPoint.lat.toFixed(4)}, {destPoint.lon.toFixed(4)}</div>
                  </div>
                </Popup>
              </Marker>
            )}

            {/* Vehicle marker */}
            {vehiclePos && (
              <Marker
                position={[vehiclePos.lat, vehiclePos.lon]}
                icon={createVehicleIcon(vehiclePos.strayed, vehiclePos.bearing || 0)}
                zIndexOffset={1000}
              >
                <Popup>
                  <div className="map-popup-card">
                    <strong>{vehiclePos.isRealGps ? "🛰️ Your Live Position" : "🚗 Vehicle Simulator"}</strong>
                    <div>Speed: <strong>{vehiclePos.speed || 0} km/h</strong></div>
                    <div>Heading: {Math.round(vehiclePos.bearing || 0)}°</div>
                    {vehiclePos.accuracy && <div>Accuracy: ±{vehiclePos.accuracy}m</div>}
                  </div>
                </Popup>
              </Marker>
            )}

            {/* Blocked Road Indicators */}
            {roadGraph && Array.from(roadGraph.blockedEdges).map((key) => {
              const [fromId] = key.split("-");
              const node = roadGraph.nodes[fromId];
              if (!node) return null;
              return (
                <CircleMarker
                  key={`block-${key}`}
                  center={[node.lat, node.lon]}
                  radius={7}
                  pathOptions={{
                    color: "#f43f5e",
                    fillColor: "#f43f5e",
                    fillOpacity: 0.8,
                    weight: 2,
                  }}
                >
                  <Popup>🚧 Simulated Road Block</Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        )}


        {/* ── Route Planning Card (Floating Top-Left) ──── */}
        <aside className="route-picker-panel">
          <div className="glass-card">
            <div className="glass-card-header">
              <div className="glass-card-title-wrap">
                <span className="glass-card-icon">📍</span>
                <h2 className="glass-card-title">Route Planner</h2>
              </div>
              {startPoint && destPoint && (
                <button
                  className="btn-icon-subtle"
                  onClick={handleSwapPoints}
                  title="Swap Start and Destination"
                >
                  ⇄
                </button>
              )}
            </div>

            <div className="glass-card-body">
              {/* Pickup Point Selection */}
              <div className="route-input-group">
                <div className="route-input-label">
                  <span className="dot dot-pickup"></span>
                  <span>Pickup / Source</span>
                </div>
                <div className="route-btn-grid">
                  <button
                    className={`btn ${startPoint?.isCurrentGps ? "btn--emerald" : "btn--glass"}`}
                    onClick={() => handleUseCurrentLocation("start")}
                  >
                    📍 Current Location
                  </button>
                  <button
                    className={`btn ${pickingMode === "start" ? "btn--primary" : "btn--glass"}`}
                    onClick={() => setPickingMode(pickingMode === "start" ? null : "start")}
                  >
                    {pickingMode === "start" ? "👆 Tap Map…" : "🗺️ Set on Map"}
                  </button>
                </div>
                {startPoint && (
                  <div className="coord-chip">
                    <span>{startPoint.isCurrentGps ? "🟢 Live GPS Locked" : `📌 ${startPoint.lat.toFixed(4)}, ${startPoint.lon.toFixed(4)}`}</span>
                  </div>
                )}
              </div>

              {/* Destination Point Selection */}
              <div className="route-input-group" style={{ marginTop: 10 }}>
                <div className="route-input-label">
                  <span className="dot dot-dest"></span>
                  <span>Destination</span>
                </div>
                <button
                  className={`btn btn--full ${pickingMode === "destination" ? "btn--primary" : "btn--glass"}`}
                  onClick={() => setPickingMode(pickingMode === "destination" ? null : "destination")}
                >
                  {pickingMode === "destination" ? "👆 Tap Destination on Map…" : "🗺️ Pick Destination on Map"}
                </button>
                {destPoint && (
                  <div className="coord-chip">
                    <span>🏁 {destPoint.lat.toFixed(4)}, {destPoint.lon.toFixed(4)}</span>
                  </div>
                )}
              </div>

              {/* Primary Action Button */}
              <button
                className={`btn btn--primary btn--hero btn--full ${activeRoute ? "btn--hero-active" : ""}`}
                onClick={handleStartNavigationAction}
                style={{ marginTop: 12 }}
              >
                {activeRoute ? (simRunning ? "⏸ Pause Navigation" : "🚀 Start Navigation") : "🧭 Calculate & Navigate"}
              </button>

              {/* Clear Route Button if Route Exists */}
              {activeRoute && (
                <button
                  className="btn btn--glass btn--sm btn--full"
                  onClick={handleClearRoute}
                  style={{ marginTop: 6 }}
                >
                  ✕ Clear Route
                </button>
              )}

              {/* Sample Highway Runs */}
              <div className="sample-routes-section">
                <span className="sample-routes-title">Sample Highway Runs:</span>
                <div className="sample-routes-grid">
                  {SAMPLE_HIGHWAY_ROUTES.map((p) => (
                    <button
                      key={p.id}
                      className="sample-route-chip"
                      onClick={() => handleSelectSampleHighway(p)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </aside>


        {/* ── Navigation HUD (Floating Bottom/Driving HUD) ──── */}
        {activeRoute && !loading && (
          <div className="nav-hud-floating">
            <div className="nav-hud-main">
              {/* Maneuver Big Icon */}
              <div className="nav-maneuver-badge">
                <span className="maneuver-icon">{currentInstr?.icon || "⬆️"}</span>
              </div>

              {/* Next Instruction Text */}
              <div className="nav-instruction-wrap">
                <div className="nav-instruction-text">{currentInstr?.text || "Continue along route"}</div>
                {currentInstr?.streetName && (
                  <div className="nav-street-text">{currentInstr.streetName}</div>
                )}
              </div>

              {/* Speedometer Badge */}
              <div className="nav-speed-badge">
                <span className="speed-val">{vehiclePos?.speed || 0}</span>
                <span className="speed-unit">KM/H</span>
              </div>
            </div>

            {/* Navigation Metrics Strip */}
            <div className="nav-hud-metrics">
              <div className="metric-cell">
                <span className="metric-val">
                  {distRemaining >= 1
                    ? `${distRemaining.toFixed(1)} km`
                    : distRemaining > 0
                      ? `${Math.round(distRemaining * 1000)} m`
                      : `${activeRoute.distance.toFixed(1)} km`
                  }
                </span>
                <span className="metric-lbl">Remaining</span>
              </div>

              <div className="metric-divider"></div>

              <div className="metric-cell">
                <span className="metric-val">{eta !== "--" ? eta : computeETA(activeRoute.distance)}</span>
                <span className="metric-lbl">Est. Time</span>
              </div>

              <div className="metric-divider"></div>

              <div className="metric-cell">
                <span className={`status-pill status-pill--${netInfo.isOffline ? "offline" : "online"}`}>
                  {netInfo.isOffline ? "Offline A*" : "OSRM Fast"}
                </span>
                <span className="metric-lbl">Routing Mode</span>
              </div>
            </div>

            {/* Expandable Turn Directions Drawer */}
            <div className="nav-steps-toggle-bar">
              <button
                className="btn-text-toggle"
                onClick={() => setShowSteps(!showSteps)}
              >
                {showSteps ? "▲ Hide Turn-by-Turn List" : `▼ View ${instructions.length} Turn Directions`}
              </button>
            </div>

            {showSteps && instructions.length > 0 && (
              <div className="nav-steps-list">
                {instructions.map((ins, idx) => (
                  <div key={idx} className="nav-step-row">
                    <span className="step-row-icon">{ins.icon}</span>
                    <div className="step-row-text-wrap">
                      <div className="step-row-text">{ins.text}</div>
                      {ins.streetName && <div className="step-row-street">{ins.streetName}</div>}
                    </div>
                    <span className="step-row-dist">
                      {ins.distanceM > 999 ? `${(ins.distanceM / 1000).toFixed(1)} km` : `${ins.distanceM} m`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}


        {/* ── Floating Map Action Buttons (Bottom Right FABs) ─ */}
        <div className="map-fabs-container">
          {/* Recenter Button */}
          <button
            className="fab-btn"
            onClick={handleRecenterVehicle}
            title="Recenter on My Location"
          >
            🎯
          </button>

          {/* Quick Roadblock Simulation Button */}
          {activeRoute && (
            <button
              className="fab-btn fab-btn--danger"
              onClick={handleBlockRoad}
              title="Simulate Roadblock Ahead"
            >
              🚧
            </button>
          )}

          {/* Offline/Online Quick Toggle */}
          <button
            className="fab-btn"
            onClick={() => netRef.current?.toggleSimulation()}
            title={netInfo.isOffline ? "Restore Online Connection" : "Simulate Going Offline"}
          >
            {netInfo.isOffline ? "🌐" : "📡"}
          </button>
        </div>


        {/* ── Control / Debug Drawers (Top-Right) ────── */}
        <aside className="control-panel">

          {/* Drive & Hardware GPS Controller */}
          <div className="glass-card glass-card--sm">
            <div
              className="glass-card-header"
              onClick={() => togglePanel("tracking")}
            >
              <div className="glass-card-title-wrap">
                <span className="glass-card-icon">{gpsMode === "real" ? "🛰️" : "🎮"}</span>
                <h3 className="glass-card-title">
                  {gpsMode === "real" ? "Live Satellite GPS" : "Drive Simulator"}
                </h3>
              </div>
              <span className={`panel-toggle-arrow ${panelOpen.tracking ? "open" : ""}`}>▾</span>
            </div>

            {panelOpen.tracking && (
              <div className="glass-card-body">
                {gpsMode === "real" ? (
                  <div className="gps-live-dashboard">
                    <div className="live-pill">
                      <span className="live-dot-pulse"></span>
                      <span>Hardware Satellites Streaming</span>
                    </div>
                    <div className="gps-grid-3">
                      <div className="gps-stat-card">
                        <span className="gps-stat-val">{vehiclePos?.speed || 0}</span>
                        <span className="gps-stat-lbl">KM/H</span>
                      </div>
                      <div className="gps-stat-card">
                        <span className="gps-stat-val">{vehiclePos?.accuracy ? `±${vehiclePos.accuracy}m` : "High"}</span>
                        <span className="gps-stat-lbl">Accuracy</span>
                      </div>
                      <div className="gps-stat-card">
                        <span className="gps-stat-val">{Math.round(vehiclePos?.bearing || 0)}°</span>
                        <span className="gps-stat-lbl">Heading</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="sim-controls-wrap">
                    <div className="btn-group">
                      <button
                        className={`btn ${simRunning ? "btn--danger" : "btn--primary"} btn--sm`}
                        onClick={handleStartPauseSim}
                        disabled={!activeRoute}
                      >
                        {simRunning ? "⏸ Pause" : "▶ Start Drive"}
                      </button>
                      <button className="btn btn--glass btn--sm" onClick={handleResetSim}>
                        ↺ Reset
                      </button>
                    </div>

                    <div className="speed-slider-wrap">
                      <span className="speed-lbl">Sim Speed: <strong>{simSpeed}x</strong></span>
                      <input
                        type="range"
                        className="custom-range-slider"
                        min="1" max="10" step="1"
                        value={simSpeed}
                        onChange={handleSpeedChange}
                      />
                    </div>

                    <div className="btn-group">
                      <button
                        className="btn btn--glass btn--sm"
                        onClick={handleStray}
                        disabled={!simRunning}
                      >
                        ↗ Stray Off
                      </button>
                      <button
                        className="btn btn--danger btn--sm"
                        onClick={handleBlockRoad}
                        disabled={!simRunning}
                      >
                        🚧 Block Road
                      </button>
                    </div>

                    <button
                      className="btn btn--glass btn--sm btn--full"
                      onClick={handleClearBlocks}
                      style={{ marginTop: 6 }}
                    >
                      ✅ Clear All Blocks
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Offline Corridor Cache Inspector */}
          <div className="glass-card glass-card--sm" style={{ marginTop: 8 }}>
            <div className="glass-card-header" onClick={() => togglePanel("cache")}>
              <div className="glass-card-title-wrap">
                <span className="glass-card-icon">💾</span>
                <h3 className="glass-card-title">Corridor Cache</h3>
              </div>
              <span className={`panel-toggle-arrow ${panelOpen.cache ? "open" : ""}`}>▾</span>
            </div>

            {panelOpen.cache && (
              <div className="glass-card-body">
                <div className="cache-info-list">
                  <div className="cache-row">
                    <span>Corridor Status:</span>
                    <strong style={{ color: "#10b981" }}>{cacheInfo.exists ? "Cached in RAM" : "Empty"}</strong>
                  </div>
                  {cacheInfo.meta && (
                    <>
                      <div className="cache-row">
                        <span>Road Nodes:</span>
                        <strong>{cacheInfo.meta.nodeCount}</strong>
                      </div>
                      <div className="cache-row">
                        <span>Memory Footprint:</span>
                        <strong>{cacheInfo.meta.sizeKB} KB</strong>
                      </div>
                    </>
                  )}
                </div>

                <div className="checkbox-wrap" style={{ marginTop: 8 }}>
                  <label className="custom-checkbox-label">
                    <input
                      type="checkbox"
                      checked={showGraphOverlay}
                      onChange={(e) => setShowGraphOverlay(e.target.checked)}
                    />
                    <span>Show Corridor Graph Overlay</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Live Reroute Latency Log */}
          <div className="glass-card glass-card--sm" style={{ marginTop: 8 }}>
            <div className="glass-card-header" onClick={() => togglePanel("log")}>
              <div className="glass-card-title-wrap">
                <span className="glass-card-icon">⚡</span>
                <h3 className="glass-card-title">Activity Log ({rerouteLog.length})</h3>
              </div>
              <span className={`panel-toggle-arrow ${panelOpen.log ? "open" : ""}`}>▾</span>
            </div>

            {panelOpen.log && (
              <div className="glass-card-body">
                <div className="log-entries-scroll">
                  {rerouteLog.length === 0 ? (
                    <div className="log-empty">No activity yet</div>
                  ) : (
                    rerouteLog.map((item) => (
                      <div key={item.id} className="log-entry-row">
                        <span className="log-time">{item.time}</span>
                        <span className="log-text">{item.text}</span>
                        {item.latency && <span className="log-latency">{item.latency}</span>}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>

      </main>
    </div>
  );
}