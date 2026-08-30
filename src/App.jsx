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


// ── Google Maps Style Marker Icons ───────────────────────
const startIcon = L.divIcon({
  className: "",
  html: `<div class="gmap-pin gmap-pin--start">
    <div class="gmap-pin-circle"></div>
  </div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const destIcon = L.divIcon({
  className: "",
  html: `<div class="gmap-pin gmap-pin--dest">
    <div class="gmap-dest-flag">🏁</div>
  </div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 30],
});

function createVehicleIcon(strayed, heading = 0) {
  return L.divIcon({
    className: "",
    html: `
      <div class="gmap-vehicle-beacon" style="transform: rotate(${heading}deg);">
        <div class="gmap-radar-ring"></div>
        <div class="gmap-nav-chevron ${strayed ? "gmap-nav-chevron--strayed" : ""}"></div>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
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
      if (onMapClick) {
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


// Initial fallback center
const NEUTRAL_CENTER = [20.5937, 78.9629];
const NEUTRAL_ZOOM = 5;


// ══════════════════════════════════════════════════════════
//  MAIN APP (Google Maps UI)
// ══════════════════════════════════════════════════════════

export default function App() {
  // ── Core state ──────────────────────────────────────────
  const [roadGraph, setRoadGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState("Acquiring GPS location…");

  // ── Locations ───────────────────────────────────────────
  const [startPoint, setStartPoint] = useState(null);   // { lat, lon, isCurrentGps }
  const [destPoint, setDestPoint] = useState(null);      // { lat, lon }
  const [pickingMode, setPickingMode] = useState(null); // null | "start" | "destination"
  const [toastMsg, setToastMsg] = useState(null);

  // ── Navigation UI mode: "explore" | "planning" | "navigating" ───
  const [isNavigating, setIsNavigating] = useState(false);
  const [showBottomDrawer, setShowBottomDrawer] = useState(true);
  const [showTurnList, setShowTurnList] = useState(false);

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


  // ── Initialize App & Auto-Detect User's Real GPS Location ─
  useEffect(() => {
    async function init() {
      setLoading(true);
      setLoadingMsg("Detecting your live location…");

      const monitor = new NetworkMonitor();
      netRef.current = monitor;
      setNetInfo(monitor.getInfo());
      monitor.onChange((info) => setNetInfo(info));

      const gps = new GPSSimulator();
      gpsRef.current = gps;
      const realGps = new RealGPSTracker();
      realGpsRef.current = realGps;

      // Auto-query user's live physical GPS location on launch
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

        realGps.start();
        setGpsMode("real");
      } catch (err) {
        console.info("Location permission pending:", err.message);
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


  // ── Map click handler (Direct 1-tap Google Maps destination picking) ─
  function handleMapClick(lat, lon) {
    if (pickingMode === "start") {
      setStartPoint({ lat, lon, isCurrentGps: false });
      setPickingMode(null);
      showToast("📍 Start point updated");
    } else {
      // Default: 1-tap on map sets Destination!
      setDestPoint({ lat, lon });
      setPickingMode(null);
      setShowBottomDrawer(true);
      showToast("🏁 Destination set! Calculating route…");
    }
  }


  // ── Sample Highway Presets ─────────────────────────────
  const SAMPLE_HIGHWAY_ROUTES = [
    {
      id: "hubballi_ballari",
      label: "Hubballi → Ballari (150 km)",
      start: { lat: 15.3647, lon: 75.1240 },
      dest: { lat: 15.1394, lon: 76.9214 },
    },
    {
      id: "hyderabad_vijayawada",
      label: "Hyderabad → Vijayawada (275 km)",
      start: { lat: 17.3850, lon: 78.4867 },
      dest: { lat: 16.5062, lon: 80.6480 },
    },
    {
      id: "bengaluru_tirupati",
      label: "Bengaluru → Tirupati (250 km)",
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
    setShowBottomDrawer(true);
    showToast(`Loaded: ${preset.label}`);
  }


  // ── Compute route when Start and Dest are set ───────────
  useEffect(() => {
    if (!startPoint || !destPoint) return;

    async function calculateRoute() {
      const t0 = performance.now();

      // 1. If Online: High-speed Global OSRM Routing
      if (netInfo.isOnline) {
        try {
          const globalResult = await fetchGlobalRoute(
            startPoint.lat,
            startPoint.lon,
            destPoint.lat,
            destPoint.lon
          );

          // Build in-memory corridor graph for offline failover
          const corridorData = buildCorridorGraph(globalResult);
          const corridorGraph = new RoadGraph(corridorData);
          graphRef.current = corridorGraph;
          setRoadGraph(corridorGraph);
          CacheManager.save(corridorGraph);

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

          // Fit bounds smoothly
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
          return;
        } catch (err) {
          console.warn("Global routing fallback:", err);
        }
      }

      // 2. If Offline: In-memory A*
      const graph = graphRef.current;
      if (!graph) return;

      const startResult = findNearestNode(graph.nodes, startPoint.lat, startPoint.lon);
      const goalResult = findNearestNode(graph.nodes, destPoint.lat, destPoint.lon);

      if (!startResult.nodeId || !goalResult.nodeId) {
        showToast("⚠️ Points outside cached corridor");
        return;
      }

      const result = aStar(graph, startResult.nodeId, goalResult.nodeId);

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
      }
    }

    calculateRoute();
  }, [startPoint, destPoint]);


  // ── Start Turn-by-Turn Navigation (Google Maps Style) ───
  function handleStartNavigation() {
    if (!destPoint) {
      showToast("👆 Tap anywhere on the map to set a Destination");
      return;
    }

    setIsNavigating(true);
    setShowBottomDrawer(false);
    setFollowVehicle(true);

    if (vehiclePos) {
      setMapViewCenter([vehiclePos.lat, vehiclePos.lon]);
      setMapViewZoom(17);
    }

    if (gpsMode === "simulation") {
      const gps = gpsRef.current;
      const activeRoute = rerouteResult || routeResult;
      if (gps && activeRoute) {
        gps.setRoute(activeRoute.coords);
        gps.start();
        setSimRunning(true);
      }
    } else {
      realGpsRef.current?.start();
      showToast("🛰️ Navigating with live GPS");
    }
  }

  function handleExitNavigation() {
    setIsNavigating(false);
    if (gpsRef.current) gpsRef.current.pause();
    setSimRunning(false);
    setShowBottomDrawer(true);
    showToast("Navigation ended");
  }


  // ── Re-route logic (adaptive) ──────────────────────────
  const reroute = useCallback(
    async (lat, lon) => {
      const graph = graphRef.current;
      const origRoute = routeResult;
      if (!origRoute || !destPoint) return;

      if (netInfo.isOnline) {
        try {
          const globalResult = await fetchGlobalRoute(lat, lon, destPoint.lat, destPoint.lon);
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

          if (gpsRef.current) {
            gpsRef.current.setRoute(globalResult.coords);
            gpsRef.current.returnToRoute();
            if (simRunning) gpsRef.current.start();
          }
          return;
        } catch (err) {
          console.warn("Online reroute fallback:", err);
        }
      }

      if (!graph) return;
      const startResult = findNearestNode(graph.nodes, lat, lon);
      const goalId = origRoute.path[origRoute.path.length - 1];
      const newRoute = aStar(graph, startResult.nodeId, goalId);

      if (newRoute) {
        setRerouteResult(newRoute);
        const newInstrs = generateInstructions(newRoute, graph);
        setInstructions(newInstrs);
        setCurrentInstr(newInstrs[0] || null);

        if (gpsRef.current) {
          gpsRef.current.setRoute(newRoute.coords);
          gpsRef.current.returnToRoute();
          if (simRunning) gpsRef.current.start();
        }
      }
    },
    [routeResult, destPoint, netInfo.isOnline, simRunning]
  );


  // ── Unified GPS position update handler ────────────────
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
      } catch {
        showToast("⚠️ Location access required");
        setGpsMode("simulation");
      }
    } else {
      realGpsRef.current?.stop();
      showToast("🚗 Switched to Drive Simulator");
    }
  }

  async function handleUseCurrentLocation() {
    try {
      showToast("📡 Connecting to GPS satellites…");
      const loc = await realGpsRef.current.getCurrentLocation();
      loc.isCurrentGps = true;
      setStartPoint(loc);
      setVehiclePos({ ...loc, speed: loc.speed || 0, bearing: 0, isRealGps: true });
      setMapViewCenter([loc.lat, loc.lon]);
      setMapViewZoom(16);
      setFollowVehicle(true);
      realGpsRef.current.start();
      setGpsMode("real");
      showToast("📍 Locked to current location");
    } catch {
      showToast("👆 Tap anywhere on map to set Pickup point");
      setPickingMode("start");
    }
  }

  function handleRecenterVehicle() {
    if (vehiclePos) {
      setMapViewCenter([vehiclePos.lat, vehiclePos.lon]);
      setMapViewZoom(17);
      setFollowVehicle(true);
      showToast("🎯 Centered on your location");
    } else if (startPoint) {
      setMapViewCenter([startPoint.lat, startPoint.lon]);
      setMapViewZoom(15);
      setFollowVehicle(true);
    }
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
      showToast("🚧 Roadblock simulated — Detour calculated");
      reroute(vehiclePos.lat, vehiclePos.lon);
    }
  }

  function handleClearRoute() {
    if (gpsRef.current) gpsRef.current.reset();
    setSimRunning(false);
    setIsNavigating(false);
    setOffRouteInfo(null);
    setRouteResult(null);
    setRerouteResult(null);
    setDestPoint(null);
    setInstructions([]);
    setCurrentInstr(null);
    setDistRemaining(0);
    setEta("--");
    setShowBottomDrawer(true);
    showToast("Route cleared");
  }

  function handleSwapPoints() {
    if (startPoint && destPoint) {
      const temp = startPoint;
      setStartPoint({ ...destPoint, isCurrentGps: false });
      setDestPoint(temp);
      showToast("⇄ Swapped Start & Destination");
    }
  }

  const activeRoute = rerouteResult || routeResult;


  // ══════════════════════════════════════════════════════
  //  RENDER (Google Maps UI)
  // ══════════════════════════════════════════════════════

  return (
    <div className="app gmap-app">

      {/* ── 1. Google Maps TOP BAR ───────────────────────── */}
      {!isNavigating ? (
        /* Explore / Search Capsule (Google Maps Search Bar) */
        <div className="gmap-top-search-bar">
          <div className="gmap-search-capsule">
            <span className="gmap-search-icon">🔍</span>
            <div
              className="gmap-search-text-wrap"
              onClick={() => {
                setPickingMode("destination");
                showToast("👆 Tap anywhere on the map to set Destination");
              }}
            >
              {destPoint ? (
                <span className="gmap-search-dest-active">
                  🏁 Destination ({destPoint.lat.toFixed(3)}, {destPoint.lon.toFixed(3)})
                </span>
              ) : (
                <span className="gmap-search-placeholder">
                  Where to? Tap anywhere on map
                </span>
              )}
            </div>

            {/* Quick Status / GPS mode pill inside search bar */}
            <div className="gmap-top-actions">
              <button
                className={`gmap-chip-btn ${gpsMode === "real" ? "gmap-chip-btn--active" : ""}`}
                onClick={() => handleToggleGpsMode(gpsMode === "real" ? "simulation" : "real")}
              >
                {gpsMode === "real" ? "🛰️ GPS" : "🎮 Sim"}
              </button>

              <button
                className="gmap-net-dot-btn"
                onClick={() => netRef.current?.toggleSimulation()}
                title="Toggle Online/Offline"
              >
                <span className={`net-status-dot net-status-dot--${netInfo.state}`}></span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Active Turn-by-Turn Driving Maneuver Header (Google Navigation Green Card) */
        <div className="gmap-driving-turn-header">
          <div className="gmap-maneuver-icon-wrap">
            <span className="gmap-turn-icon">{currentInstr?.icon || "⬆️"}</span>
          </div>
          <div className="gmap-turn-info">
            <div className="gmap-turn-distance">
              {currentInstr?.distanceM > 999
                ? `${(currentInstr.distanceM / 1000).toFixed(1)} km`
                : `${currentInstr?.distanceM || 0} m`}
            </div>
            <div className="gmap-turn-instruction">
              {currentInstr?.text || "Continue on route"}
            </div>
            {currentInstr?.streetName && (
              <div className="gmap-turn-street">{currentInstr.streetName}</div>
            )}
          </div>
        </div>
      )}


      {/* ── 2. Full-Screen Map Viewport ─────────────────── */}
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
          </div>
        )}

        {/* Off-Route Alert */}
        {offRouteInfo?.offRoute && (
          <div className="offroute-alert">
            <span className="offroute-alert-icon">⚡</span>
            <span>Rerouting…</span>
          </div>
        )}

        {/* Leaflet Map */}
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

            {/* Active Route Polyline */}
            {activeRoute && (
              <Polyline
                positions={activeRoute.coords}
                pathOptions={{
                  color: rerouteResult ? "#f59e0b" : "#2563eb",
                  weight: 7,
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
                    <strong>🟢 Pickup Point</strong>
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
                    <strong>{vehiclePos.isRealGps ? "🛰️ Your Location" : "🚗 Vehicle"}</strong>
                    <div>{vehiclePos.speed || 0} km/h</div>
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
                  <Popup>🚧 Roadblock</Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        )}


        {/* ── 3. Floating Right Map Controls (Google FABs) ── */}
        <div className="gmap-floating-fabs">
          <button
            className="gmap-fab"
            onClick={handleRecenterVehicle}
            title="Recenter on My Location"
          >
            🎯
          </button>

          {activeRoute && isNavigating && (
            <button
              className="gmap-fab gmap-fab--danger"
              onClick={handleBlockRoad}
              title="Simulate Road Block"
            >
              🚧
            </button>
          )}

          <button
            className="gmap-fab"
            onClick={() => netRef.current?.toggleSimulation()}
            title={netInfo.isOffline ? "Restore Online" : "Simulate Offline"}
          >
            {netInfo.isOffline ? "🌐" : "📡"}
          </button>
        </div>


        {/* ── 4. Google Maps BOTTOM SHEET (Pre-Navigation) ─── */}
        {!isNavigating && showBottomDrawer && (
          <div className="gmap-bottom-sheet">
            <div className="gmap-sheet-handle"></div>

            {/* Route Summary Row */}
            <div className="gmap-sheet-header">
              <div className="gmap-sheet-title-row">
                <span className="gmap-sheet-title">
                  {destPoint ? "Route Directions" : "Choose Destination"}
                </span>
                {destPoint && (
                  <button className="gmap-btn-link" onClick={handleClearRoute}>
                    ✕ Clear
                  </button>
                )}
              </div>

              {/* Origin & Destination Inputs */}
              <div className="gmap-route-inputs">
                <div className="gmap-route-input-row" onClick={handleUseCurrentLocation}>
                  <span className="gmap-dot gmap-dot--origin"></span>
                  <span className="gmap-input-text">
                    {startPoint?.isCurrentGps ? "Your current location" : "Set pickup location"}
                  </span>
                  <span className="gmap-input-subtext">📍 GPS</span>
                </div>

                <div
                  className="gmap-route-input-row"
                  onClick={() => {
                    setPickingMode("destination");
                    showToast("👆 Tap anywhere on map to set Destination");
                  }}
                >
                  <span className="gmap-dot gmap-dot--dest"></span>
                  <span className="gmap-input-text">
                    {destPoint ? `Destination (${destPoint.lat.toFixed(4)}, ${destPoint.lon.toFixed(4)})` : "Tap map to set destination"}
                  </span>
                </div>
              </div>

              {/* If Route calculated: show ETA + Blue Google Start Button */}
              {activeRoute && (
                <div className="gmap-route-ready-box">
                  <div className="gmap-route-meta">
                    <span className="gmap-route-time">{activeRoute.time} min</span>
                    <span className="gmap-route-dist">({activeRoute.distance} km)</span>
                    <span className="gmap-route-tag">Fastest route</span>
                  </div>

                  <button
                    className="gmap-start-nav-btn"
                    onClick={handleStartNavigation}
                  >
                    🧭 Start Navigation
                  </button>
                </div>
              )}

              {/* Sample Highway Runs */}
              {!activeRoute && (
                <div className="gmap-highway-chips-scroll">
                  {SAMPLE_HIGHWAY_ROUTES.map((p) => (
                    <button
                      key={p.id}
                      className="gmap-highway-chip"
                      onClick={() => handleSelectSampleHighway(p)}
                    >
                      🛣️ {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}


        {/* ── 5. Google Maps DRIVING HUD (Active Driving Mode) ─── */}
        {isNavigating && activeRoute && (
          <div className="gmap-driving-footer">
            <div className="gmap-driving-footer-main">
              {/* Trip Time & Distance (Large Green/Blue Text) */}
              <div className="gmap-footer-metrics">
                <div className="gmap-footer-time-dist">
                  <span className="gmap-primary-eta">{eta !== "--" ? eta : computeETA(activeRoute.distance)}</span>
                  <span className="gmap-primary-dist">
                    {distRemaining >= 1
                      ? `${distRemaining.toFixed(1)} km`
                      : `${Math.round(distRemaining * 1000)} m`
                    }
                  </span>
                </div>
                <div className="gmap-footer-speed">
                  Speed: <strong>{vehiclePos?.speed || 0} km/h</strong> • {netInfo.isOffline ? "Offline A*" : "OSRM Fast"}
                </div>
              </div>

              {/* Red Exit Navigation Button */}
              <button
                className="gmap-exit-nav-btn"
                onClick={handleExitNavigation}
                title="Exit Navigation"
              >
                ✕
              </button>
            </div>

            {/* Turn-by-Turn list toggle */}
            <div className="gmap-turn-list-toggle">
              <button
                className="gmap-toggle-link"
                onClick={() => setShowTurnList(!showTurnList)}
              >
                {showTurnList ? "▲ Hide Steps" : `▼ View ${instructions.length} Turn Directions`}
              </button>
            </div>

            {showTurnList && (
              <div className="gmap-steps-drawer">
                {instructions.map((ins, idx) => (
                  <div key={idx} className="gmap-step-item">
                    <span className="gmap-step-icon">{ins.icon}</span>
                    <div className="gmap-step-text-wrap">
                      <div className="gmap-step-title">{ins.text}</div>
                      {ins.streetName && <div className="gmap-step-sub">{ins.streetName}</div>}
                    </div>
                    <span className="gmap-step-dist">
                      {ins.distanceM > 999 ? `${(ins.distanceM / 1000).toFixed(1)} km` : `${ins.distanceM} m`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}