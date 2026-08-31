/**
 * Navigation Engine
 *
 * Generates turn-by-turn instructions from a route,
 * monitors GPS position for off-route detection,
 * and triggers rerouting.
 */

import { haversine, bearing } from "./osmService.js";


// ── Maneuver types ──────────────────────────────────────
const MANEUVER = {
  DEPART: "depart",
  ARRIVE: "arrive",
  STRAIGHT: "straight",
  SLIGHT_RIGHT: "slight-right",
  RIGHT: "right",
  SHARP_RIGHT: "sharp-right",
  U_TURN: "u-turn",
  SHARP_LEFT: "sharp-left",
  LEFT: "left",
  SLIGHT_LEFT: "slight-left",
};


// ── Determine maneuver from bearing change ──────────────
function getManeuver(angleDiff) {
  // Normalize to -180..180
  let d = ((angleDiff % 360) + 540) % 360 - 180;

  if (Math.abs(d) < 15) return MANEUVER.STRAIGHT;
  if (d >= 15 && d < 45) return MANEUVER.SLIGHT_RIGHT;
  if (d >= 45 && d < 120) return MANEUVER.RIGHT;
  if (d >= 120 && d < 170) return MANEUVER.SHARP_RIGHT;
  if (d >= 170) return MANEUVER.U_TURN;
  if (d <= -15 && d > -45) return MANEUVER.SLIGHT_LEFT;
  if (d <= -45 && d > -120) return MANEUVER.LEFT;
  if (d <= -120 && d > -170) return MANEUVER.SHARP_LEFT;
  if (d <= -170) return MANEUVER.U_TURN;

  return MANEUVER.STRAIGHT;
}


// ── Maneuver display info ───────────────────────────────
const MANEUVER_ICONS = {
  [MANEUVER.DEPART]: "🚀",
  [MANEUVER.ARRIVE]: "🏁",
  [MANEUVER.STRAIGHT]: "⬆️",
  [MANEUVER.SLIGHT_RIGHT]: "↗️",
  [MANEUVER.RIGHT]: "➡️",
  [MANEUVER.SHARP_RIGHT]: "↘️",
  [MANEUVER.U_TURN]: "🔄",
  [MANEUVER.SHARP_LEFT]: "↙️",
  [MANEUVER.LEFT]: "⬅️",
  [MANEUVER.SLIGHT_LEFT]: "↖️",
};

const MANEUVER_TEXT = {
  [MANEUVER.DEPART]: "Depart",
  [MANEUVER.ARRIVE]: "You have arrived",
  [MANEUVER.STRAIGHT]: "Continue straight",
  [MANEUVER.SLIGHT_RIGHT]: "Turn slightly right",
  [MANEUVER.RIGHT]: "Turn right",
  [MANEUVER.SHARP_RIGHT]: "Turn sharp right",
  [MANEUVER.U_TURN]: "Make a U-turn",
  [MANEUVER.SHARP_LEFT]: "Turn sharp left",
  [MANEUVER.LEFT]: "Turn left",
  [MANEUVER.SLIGHT_LEFT]: "Turn slightly left",
};


/**
 * Generate turn-by-turn instructions from route data.
 *
 * @param {object} routeResult - Result from aStar()
 * @param {object} roadGraph - RoadGraph instance
 * @returns {Array<{maneuver, icon, text, streetName, distanceM, coord}>}
 */
export function generateInstructions(routeResult, roadGraph) {
  if (!routeResult || routeResult.path.length < 2) {
    return [];
  }

  const { path, coords } = routeResult;
  const instructions = [];

  // Departure instruction
  const firstEdgeMeta = roadGraph.edgeMeta?.[`${path[0]}-${path[1]}`];
  instructions.push({
    maneuver: MANEUVER.DEPART,
    icon: MANEUVER_ICONS[MANEUVER.DEPART],
    text: `Head towards ${firstEdgeMeta?.name || "the road"}`,
    streetName: firstEdgeMeta?.name || "Unknown",
    distanceM: 0,
    coord: coords[0],
    pathIndex: 0,
  });

  let prevBearing = bearing(
    { lat: coords[0][0], lon: coords[0][1] },
    { lat: coords[1][0], lon: coords[1][1] }
  );

  let accumulatedDist = 0;
  let currentStreet = firstEdgeMeta?.name || "Unknown";

  for (let i = 1; i < path.length - 1; i++) {
    const segDist = haversine(
      { lat: coords[i - 1][0], lon: coords[i - 1][1] },
      { lat: coords[i][0], lon: coords[i][1] }
    ) * 1000; // → meters

    accumulatedDist += segDist;

    const nextBearing = bearing(
      { lat: coords[i][0], lon: coords[i][1] },
      { lat: coords[i + 1][0], lon: coords[i + 1][1] }
    );

    const angleDiff = nextBearing - prevBearing;
    const maneuver = getManeuver(angleDiff);

    // Check if street name changed
    const edgeMeta = roadGraph.edgeMeta?.[`${path[i]}-${path[i + 1]}`];
    const nextStreet = edgeMeta?.name || currentStreet;

    // Only emit instruction on significant turns or street changes
    if (maneuver !== MANEUVER.STRAIGHT || nextStreet !== currentStreet) {
      const text = maneuver === MANEUVER.STRAIGHT
        ? `Continue onto ${nextStreet}`
        : `${MANEUVER_TEXT[maneuver]} onto ${nextStreet}`;

      instructions.push({
        maneuver,
        icon: MANEUVER_ICONS[maneuver],
        text,
        streetName: nextStreet,
        distanceM: Math.round(accumulatedDist),
        coord: coords[i],
        pathIndex: i,
      });

      accumulatedDist = 0;
      currentStreet = nextStreet;
    }

    prevBearing = nextBearing;
  }

  // Final segment distance
  if (coords.length >= 2) {
    const lastDist = haversine(
      { lat: coords[coords.length - 2][0], lon: coords[coords.length - 2][1] },
      { lat: coords[coords.length - 1][0], lon: coords[coords.length - 1][1] }
    ) * 1000;
    accumulatedDist += lastDist;
  }

  // Arrival instruction
  instructions.push({
    maneuver: MANEUVER.ARRIVE,
    icon: MANEUVER_ICONS[MANEUVER.ARRIVE],
    text: "You have arrived at your destination",
    streetName: currentStreet,
    distanceM: Math.round(accumulatedDist),
    coord: coords[coords.length - 1],
    pathIndex: path.length - 1,
  });

  return instructions;
}


/**
 * Find the closest point on the route to a GPS position.
 *
 * @returns {{ index, distance, progress }}
 */
export function findPositionOnRoute(routeCoords, lat, lon) {
  let minDist = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < routeCoords.length; i++) {
    const d = haversine(
      { lat, lon },
      { lat: routeCoords[i][0], lon: routeCoords[i][1] }
    );
    if (d < minDist) {
      minDist = d;
      bestIdx = i;
    }
  }

  return {
    index: bestIdx,
    distance: minDist * 1000,         // meters
    progress: bestIdx / (routeCoords.length - 1),
  };
}


/**
 * Check if the user is off-route or heading in the wrong direction.
 * Returns true if distance from route > thresholdMeters OR if vehicle is moving opposite to route bearing.
 */
export function isOffRoute(routeCoords, lat, lon, heading = null, speed = 0, thresholdMeters = 35) {
  if (!routeCoords || routeCoords.length === 0) {
    return { offRoute: false, isDiverged: false, isWrongDirection: false, distanceFromRoute: 0, nearestIndex: 0, progress: 0 };
  }

  const pos = findPositionOnRoute(routeCoords, lat, lon);
  
  let isWrongDirection = false;
  if (speed > 4 && heading !== null && heading !== undefined && !isNaN(heading) && pos.index < routeCoords.length - 1) {
    const nextCoord = routeCoords[pos.index + 1];
    const curCoord = routeCoords[pos.index];
    const expectedBearing = bearing(
      { lat: curCoord[0], lon: curCoord[1] },
      { lat: nextCoord[0], lon: nextCoord[1] }
    );
    let diff = Math.abs(expectedBearing - heading);
    if (diff > 180) diff = 360 - diff;
    if (diff > 105) {
      isWrongDirection = true;
    }
  }

  const isDiverged = pos.distance > thresholdMeters;
  return {
    offRoute: isDiverged || isWrongDirection,
    isDiverged,
    isWrongDirection,
    distanceFromRoute: pos.distance,
    nearestIndex: pos.index,
    progress: pos.progress,
  };
}


/**
 * Get the next upcoming instruction for the current position with real-time distance countdown.
 */
export function getNextInstruction(instructions, currentPathIndex, currentCoord = null) {
  if (!instructions || instructions.length === 0) return null;

  // 1. Look for next upcoming intermediate maneuver/turn
  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (instr.maneuver === "arrive") continue;

    // Check if this turn is ahead of our current index
    if (instr.pathIndex >= currentPathIndex) {
      if (currentCoord && instr.coord) {
        const liveDistM = Math.round(
          haversine(
            { lat: currentCoord[0], lon: currentCoord[1] },
            { lat: instr.coord[0], lon: instr.coord[1] }
          ) * 1000
        );

        // If we are still approaching this turn (> 15m away)
        if (liveDistM > 15) {
          let textWithDistance = instr.text;
          if (liveDistM > 1000) {
            textWithDistance = `In ${(liveDistM / 1000).toFixed(1)} km, ${instr.text}`;
          } else if (liveDistM > 35) {
            textWithDistance = `In ${liveDistM} m, ${instr.text}`;
          }

          return {
            ...instr,
            text: textWithDistance,
            distanceM: liveDistM,
          };
        }
      } else {
        return instr;
      }
    }
  }

  // 2. If all intermediate turns are passed, we are on the final stretch to destination
  const last = instructions[instructions.length - 1];
  if (last && currentCoord && last.coord) {
    const destDistM = Math.round(
      haversine(
        { lat: currentCoord[0], lon: currentCoord[1] },
        { lat: last.coord[0], lon: last.coord[1] }
      ) * 1000
    );

    // Only declare arrival if physically within 35 meters
    if (destDistM <= 35) {
      return {
        maneuver: "arrive",
        icon: "🏁",
        text: "You have arrived at your destination",
        streetName: last.streetName || "Destination",
        distanceM: 0,
      };
    }

    return {
      maneuver: "straight",
      icon: "⬆️",
      text: destDistM > 1000
        ? `Continue ${(destDistM / 1000).toFixed(1)} km to destination`
        : `Continue ${destDistM} m to destination`,
      streetName: last.streetName || "Destination",
      distanceM: destDistM,
    };
  }

  return last || null;
}


/**
 * Compute remaining distance from a point on the route to the end.
 */
export function remainingDistance(routeCoords, fromIndex) {
  let dist = 0;
  for (let i = fromIndex; i < routeCoords.length - 1; i++) {
    dist += haversine(
      { lat: routeCoords[i][0], lon: routeCoords[i][1] },
      { lat: routeCoords[i + 1][0], lon: routeCoords[i + 1][1] }
    );
  }
  return dist;  // km
}


/**
 * Compute ETA based on remaining distance and average speed.
 */
export function computeETA(remainingKm, avgSpeedKmh = 35) {
  const hours = remainingKm / avgSpeedKmh;
  const mins = Math.round(hours * 60);
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
