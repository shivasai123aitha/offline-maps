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
import { searchPlaces, reverseGeocode } from "./services/geocodingService.js";


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
  html: `<div style="position:relative;width:28px;height:40px">
    <svg viewBox="0 0 28 40" width="28" height="40">
      <path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="#EA4335"/>
      <circle cx="14" cy="14" r="6" fill="#B31412"/>
      <circle cx="14" cy="14" r="4" fill="white"/>
    </svg>
  </div>`,
  iconSize: [28, 40],
  iconAnchor: [14, 40],
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
// ── Map view controller ──────────────────────────────────
function MapViewController({ center, zoom, vehiclePos, followVehicle, isNavigating, activeRoute }) {
  const map = useMap();
  const lastRouteKeyRef = useRef(null);

  // Auto fit route bounds when a route is computed (works for short & long distances)
  useEffect(() => {
    if (activeRoute && activeRoute.coords && activeRoute.coords.length > 1 && !isNavigating) {
      const routeKey = `${activeRoute.coords[0]}-${activeRoute.coords[activeRoute.coords.length - 1]}`;
      if (lastRouteKeyRef.current !== routeKey) {
        lastRouteKeyRef.current = routeKey;
        const bounds = L.latLngBounds(activeRoute.coords);
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
      }
    }
  }, [activeRoute, isNavigating, map]);

  useEffect(() => {
    // Only auto-pan if user is actively driving AND followVehicle is enabled
    if (isNavigating && vehiclePos && followVehicle) {
      map.panTo([vehiclePos.lat, vehiclePos.lon], { animate: true, duration: 0.4 });
    }
  }, [vehiclePos, followVehicle, isNavigating, map]);

  return null;
}


// ── Map interaction handler ──────────────────────────────
function MapClickHandler({ onMapClick, pickingMode, onUserInteract }) {
  useMapEvents({
    click(e) {
      if (onMapClick) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
    dragstart() {
      if (onUserInteract) onUserInteract();
    },
    zoomstart() {
      if (onUserInteract) onUserInteract();
    },
    movestart() {
      if (onUserInteract) onUserInteract();
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

  // ── Text Search State ──────────────────────────────────
  const [sourceSearchText, setSourceSearchText] = useState("");
  const [destSearchText, setDestSearchText] = useState("");
  const [sourceResults, setSourceResults] = useState([]);
  const [destResults, setDestResults] = useState([]);
  const [showSourceSearch, setShowSourceSearch] = useState(false);
  const [showDestSearch, setShowDestSearch] = useState(false);
  const [startPointName, setStartPointName] = useState("");
  const [destPointName, setDestPointName] = useState("");
  const searchTimerRef = useRef(null);

  // ── Navigation UI mode: "explore" | "planning" | "navigating" ───
  const [isNavigating, setIsNavigating] = useState(false);
  const [showBottomDrawer, setShowBottomDrawer] = useState(true);
  const [showTurnList, setShowTurnList] = useState(false);

  // ── Route state ─────────────────────────────────────────
  const [routeResult, setRouteResult] = useState(null);
  const [instructions, setInstructions] = useState([]);
  const [rerouteResult, setRerouteResult] = useState(null);
  const [isRerouting, setIsRerouting] = useState(false);

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
  const lastRerouteTimeRef = useRef(0);

  // ── Audio Feedback Chime (Web Audio API) ───────────────
  function playNavSound(type = "reroute") {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === "reroute") {
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(780, ctx.currentTime + 0.25);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } else {
        osc.frequency.setValueAtTime(659.25, ctx.currentTime);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch {
      // Ignore audio failure
    }
  }

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
        setFollowVehicle(false);

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


  // ── Map click handler (Safe explicit picking) ───────────
  function handleMapClick(lat, lon) {
    if (pickingMode === "start") {
      setStartPoint({ lat, lon, isCurrentGps: false });
      setStartPointName(`Pickup (${lat.toFixed(3)}, ${lon.toFixed(3)})`);
      setVehiclePos({ lat, lon, speed: 0, bearing: 0, isRealGps: false });
      setPickingMode(null);
      showToast("📍 Pickup point set on map");
    } else if (pickingMode === "destination") {
      setDestPoint({ lat, lon });
      setDestPointName(`Destination (${lat.toFixed(3)}, ${lon.toFixed(3)})`);
      setPickingMode(null);
      setShowBottomDrawer(true);
      showToast("🏁 Destination set! Calculating route…");
    } else {
      // Not in picking mode: close dropdowns without overriding route
      setShowSourceSearch(false);
      setShowDestSearch(false);
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


  // ── Re-route logic (adaptive wrong-direction / deviation) ──
  const reroute = useCallback(
    async (lat, lon, reason = "off_route") => {
      const origRoute = routeResult;
      if (!origRoute || !destPoint) return;

      const now = Date.now();
      if (now - lastRerouteTimeRef.current < 1200) {
        return; // Debounce rapid continuous triggers
      }
      lastRerouteTimeRef.current = now;

      setIsRerouting(true);
      if (reason === "wrong_direction") {
        showToast("🔄 Wrong direction detected! Updating route…", 2200);
      } else {
        showToast("🔄 Updating route for your location…", 1800);
      }
      playNavSound("reroute");

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
          setIsRerouting(false);
          return;
        } catch (err) {
          console.warn("Online reroute fallback:", err);
        }
      }

      // Offline In-Memory Corridor Graph A* Search
      const graph = graphRef.current;
      if (graph) {
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
      }
      setIsRerouting(false);
    },
    [routeResult, destPoint, netInfo.isOnline, simRunning]
  );


  // ── Unified GPS position update handler ────────────────
  useEffect(() => {
    const activeRoute = rerouteResult || routeResult;

    const handlePos = (pos) => {
      // If user selected a custom source and is not yet navigating, keep vehicle at custom source
      if (!isNavigating && !simRunning && startPoint && !startPoint.isCurrentGps && pos.isRealGps) {
        return; // Don't let background real GPS move vehicle away from planned custom pickup
      }

      setVehiclePos(pos);

      // ONLY check off-route and trigger auto-rerouting during ACTIVE navigation or active simulation
      if ((isNavigating || simRunning) && activeRoute) {
        const offInfo = isOffRoute(
          activeRoute.coords,
          pos.lat,
          pos.lon,
          pos.bearing,
          pos.speed || 0,
          35
        );
        setOffRouteInfo(offInfo);

        if (offInfo.offRoute && (pos.strayed || isNavigating)) {
          reroute(pos.lat, pos.lon, offInfo.isWrongDirection ? "wrong_direction" : "off_route");
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
  }, [routeResult, rerouteResult, instructions, reroute, gpsMode, isNavigating]);


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
    setDestPointName("");
    setDestSearchText("");
    setSourceSearchText("");
  }

  function handleSwapPoints() {
    if (startPoint && destPoint) {
      const temp = startPoint;
      const tempName = startPointName;
      setStartPoint({ ...destPoint, isCurrentGps: false });
      setDestPoint(temp);
      setStartPointName(destPointName);
      setDestPointName(tempName);
      showToast("⇄ Swapped Start & Destination");
    }
  }

  // ── Debounced Geocoding Search ──────────────────────────
  function handleSearchInput(text, target) {
    if (target === "source") {
      setSourceSearchText(text);
    } else {
      setDestSearchText(text);
    }

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (text.trim().length < 2) {
      if (target === "source") setSourceResults([]);
      else setDestResults([]);
      return;
    }

    searchTimerRef.current = setTimeout(async () => {
      const results = await searchPlaces(text, 8);
      if (target === "source") setSourceResults(results);
      else setDestResults(results);
    }, 250);
  }

  function handleSelectPlace(place, target) {
    const point = { lat: place.lat, lon: place.lon };

    if (target === "source") {
      setStartPoint({ ...point, isCurrentGps: false });
      setVehiclePos({ ...point, speed: 0, bearing: 0, isRealGps: false });
      setStartPointName(place.shortName);
      setSourceSearchText("");
      setSourceResults([]);
      setShowSourceSearch(false);
      setMapViewCenter([place.lat, place.lon]);
      setMapViewZoom(15);
      showToast(`📍 Pickup: ${place.shortName}`);
    } else {
      setDestPoint(point);
      setDestPointName(place.shortName);
      setDestSearchText("");
      setDestResults([]);
      setShowDestSearch(false);
      setMapViewCenter([place.lat, place.lon]);
      setMapViewZoom(15);
      showToast(`🏁 Destination: ${place.shortName}`);
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
            <div className="gmap-search-text-wrap">
              {destPoint && destPointName ? (
                <span className="gmap-search-dest-active">
                  🏁 {destPointName}
                </span>
              ) : destPoint ? (
                <span className="gmap-search-dest-active">
                  🏁 Destination ({destPoint.lat.toFixed(3)}, {destPoint.lon.toFixed(3)})
                </span>
              ) : (
                <span
                  className="gmap-search-placeholder"
                  onClick={() => {
                    setShowDestSearch(true);
                    setShowBottomDrawer(true);
                  }}
                >
                  Search here
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

        {/* Adaptive Reroute Alert */}
        {(isRerouting || offRouteInfo?.offRoute) && (
          <div className="offroute-alert">
            <span className="gmap-spin-icon">🔄</span>
            <span>{offRouteInfo?.isWrongDirection ? "Wrong direction • Recalculating…" : "Recalculating route…"}</span>
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
              isNavigating={isNavigating}
              activeRoute={activeRoute}
            />
            <MapClickHandler
              onMapClick={handleMapClick}
              pickingMode={pickingMode}
              onUserInteract={() => setFollowVehicle(false)}
            />

            {/* Active Route Polyline */}
            {activeRoute && (
              <Polyline
                positions={activeRoute.coords}
                pathOptions={{
                  color: rerouteResult ? "#fbbc04" : "#4285F4",
                  weight: 6,
                  opacity: 1,
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

              {/* Origin & Destination Inputs — Compact Two-Row Layout */}
              <div className="gmap-route-inputs">

                {/* ── ROW 1: SOURCE ── */}
                <div className="gmap-compact-row">
                  <span className="gmap-dot gmap-dot--origin"></span>
                  <button
                    type="button"
                    className={`gmap-gps-toggle ${startPoint?.isCurrentGps ? "gmap-gps-toggle--active" : ""}`}
                    onClick={() => {
                      setShowSourceSearch(false);
                      setSourceResults([]);
                      setSourceSearchText("");
                      handleUseCurrentLocation();
                    }}
                    title="Use current GPS location"
                  >
                    📍
                  </button>
                  <div className="gmap-compact-input-wrap">
                    <input
                      type="text"
                      className="gmap-text-input"
                      placeholder={startPoint?.isCurrentGps ? "📍 Current Location" : "Search pickup location…"}
                      value={startPoint?.isCurrentGps && !showSourceSearch ? "" : sourceSearchText}
                      onChange={(e) => handleSearchInput(e.target.value, "source")}
                      onFocus={() => setShowSourceSearch(true)}
                    />
                    {sourceSearchText && (
                      <button type="button" className="gmap-x-btn" onClick={() => { setSourceSearchText(""); setSourceResults([]); }}>✕</button>
                    )}
                  </div>
                </div>

                {/* Source search results */}
                {sourceResults.length > 0 && showSourceSearch && (
                  <div className="gmap-search-results">
                    {sourceResults.map((place, i) => (
                      <div key={`src-${i}`} className="gmap-search-result-item" onClick={() => handleSelectPlace(place, "source")}>
                        <span className="gmap-result-icon">{place.icon}</span>
                        <div className="gmap-result-text">
                          <div className="gmap-result-name">{place.shortName}</div>
                          <div className="gmap-result-full">{place.displayName}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── ROW 2: DESTINATION ── */}
                <div className="gmap-compact-row">
                  <span className="gmap-dot gmap-dot--dest"></span>
                  <div className="gmap-compact-input-wrap">
                    <input
                      type="text"
                      className="gmap-text-input"
                      placeholder={destPointName || "Search destination…"}
                      value={destSearchText}
                      onChange={(e) => handleSearchInput(e.target.value, "destination")}
                      onFocus={() => setShowDestSearch(true)}
                    />
                    {destSearchText && (
                      <button type="button" className="gmap-x-btn" onClick={() => { setDestSearchText(""); setDestResults([]); }}>✕</button>
                    )}
                  </div>
                  <button
                    type="button"
                    className="gmap-map-pin-btn"
                    onClick={() => { setShowDestSearch(false); setDestResults([]); setPickingMode("destination"); showToast("👆 Tap on map to set Destination"); }}
                    title="Pick on map"
                  >
                    🗺️
                  </button>
                </div>

                {/* Destination search results */}
                {destResults.length > 0 && showDestSearch && (
                  <div className="gmap-search-results">
                    {destResults.map((place, i) => (
                      <div key={`dst-${i}`} className="gmap-search-result-item" onClick={() => handleSelectPlace(place, "destination")}>
                        <span className="gmap-result-icon">{place.icon}</span>
                        <div className="gmap-result-text">
                          <div className="gmap-result-name">{place.shortName}</div>
                          <div className="gmap-result-full">{place.displayName}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

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