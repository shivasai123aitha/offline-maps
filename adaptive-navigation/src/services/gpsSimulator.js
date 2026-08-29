/**
 * GPS Simulator
 *
 * Simulates real-time vehicle movement along a route.
 * Supports variable playback speed, pausing, and
 * deliberate off-route straying for testing.
 */

import { haversine } from "./osmService.js";


export class GPSSimulator {

  constructor() {
    this.routeCoords = [];      // [[lat, lon], ...]
    this.currentIndex = 0;
    this.progress = 0;          // 0..1 within current segment
    this.speed = 1;             // playback multiplier (1x, 2x, 5x, 10x)
    this.running = false;
    this.intervalId = null;
    this.callbacks = [];        // listeners: (position) => void
    this.strayed = false;
    this.strayOffset = { lat: 0, lon: 0 };

    // Timing
    this.tickMs = 100;          // update every 100ms
    this.baseSpeedKmh = 35;    // simulated vehicle speed
  }


  // ── Load a route ──────────────────────────────────────
  setRoute(coords) {
    this.routeCoords = coords;
    this.currentIndex = 0;
    this.progress = 0;
    this.strayed = false;
    this.strayOffset = { lat: 0, lon: 0 };
  }


  // ── Subscribe to position updates ────────────────────
  onPositionUpdate(callback) {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback);
    };
  }

  _emit(position) {
    for (const cb of this.callbacks) {
      cb(position);
    }
  }


  // ── Start / Pause / Reset ────────────────────────────
  start() {
    if (this.running) return;
    if (this.routeCoords.length < 2) return;

    this.running = true;

    this.intervalId = setInterval(() => {
      this._tick();
    }, this.tickMs);
  }

  pause() {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  reset() {
    this.pause();
    this.currentIndex = 0;
    this.progress = 0;
    this.strayed = false;
    this.strayOffset = { lat: 0, lon: 0 };

    if (this.routeCoords.length > 0) {
      this._emit(this._buildPosition());
    }
  }

  setSpeed(multiplier) {
    this.speed = multiplier;
  }


  // ── Stray Off Route ──────────────────────────────────
  strayOffRoute() {
    this.strayed = true;
    // Offset 80-150 meters perpendicular to the route
    const offsetDeg = (80 + Math.random() * 70) / 111320;
    const direction = Math.random() > 0.5 ? 1 : -1;

    // Perpendicular offset
    if (this.currentIndex < this.routeCoords.length - 1) {
      const cur = this.routeCoords[this.currentIndex];
      const nxt = this.routeCoords[this.currentIndex + 1];
      const dx = nxt[1] - cur[1];
      const dy = nxt[0] - cur[0];
      const len = Math.sqrt(dx * dx + dy * dy);

      if (len > 0) {
        // Perpendicular direction
        this.strayOffset = {
          lat: (-dx / len) * offsetDeg * direction,
          lon: (dy / len) * offsetDeg * direction,
        };
      }
    } else {
      this.strayOffset = { lat: offsetDeg * direction, lon: offsetDeg * direction };
    }

    this._emit(this._buildPosition());
  }

  returnToRoute() {
    this.strayed = false;
    this.strayOffset = { lat: 0, lon: 0 };
    this._emit(this._buildPosition());
  }


  // ── Internal tick ────────────────────────────────────
  _tick() {
    if (!this.running || this.routeCoords.length < 2) return;

    // How far vehicle moves in one tick (km)
    const distPerTick =
      (this.baseSpeedKmh * this.speed) / 3600 * (this.tickMs / 1000);

    // Distance of current segment
    const segStart = this.routeCoords[this.currentIndex];
    const segEnd = this.routeCoords[this.currentIndex + 1];

    if (!segEnd) {
      // Reached end of route
      this.pause();
      this._emit({
        ...this._buildPosition(),
        finished: true,
      });
      return;
    }

    const segDist = haversine(
      { lat: segStart[0], lon: segStart[1] },
      { lat: segEnd[0], lon: segEnd[1] }
    );

    if (segDist < 0.0001) {
      // Degenerate segment, skip
      this.currentIndex++;
      this.progress = 0;
      return;
    }

    // Advance progress along segment
    this.progress += distPerTick / segDist;

    // Move to next segment(s) if needed
    while (this.progress >= 1 && this.currentIndex < this.routeCoords.length - 2) {
      this.progress -= 1;
      this.currentIndex++;

      const newStart = this.routeCoords[this.currentIndex];
      const newEnd = this.routeCoords[this.currentIndex + 1];
      if (!newEnd) break;

      const newSegDist = haversine(
        { lat: newStart[0], lon: newStart[1] },
        { lat: newEnd[0], lon: newEnd[1] }
      );
      if (newSegDist > 0.0001) {
        this.progress = (this.progress * segDist) / newSegDist;
      }
    }

    // Clamp
    if (this.currentIndex >= this.routeCoords.length - 1) {
      this.currentIndex = this.routeCoords.length - 1;
      this.progress = 0;
      this.pause();
      this._emit({ ...this._buildPosition(), finished: true });
      return;
    }

    this._emit(this._buildPosition());
  }


  // ── Build position object ────────────────────────────
  _buildPosition() {
    const idx = Math.min(this.currentIndex, this.routeCoords.length - 1);
    const coord = this.routeCoords[idx];
    const nextCoord = this.routeCoords[idx + 1] || coord;

    // Interpolate
    const t = Math.min(this.progress, 1);
    let lat = coord[0] + (nextCoord[0] - coord[0]) * t;
    let lon = coord[1] + (nextCoord[1] - coord[1]) * t;

    // Apply stray offset
    if (this.strayed) {
      lat += this.strayOffset.lat;
      lon += this.strayOffset.lon;
    }

    // Bearing
    const brng = Math.atan2(
      nextCoord[1] - coord[1],
      nextCoord[0] - coord[0]
    ) * 180 / Math.PI;

    return {
      lat,
      lon,
      bearing: (90 - brng + 360) % 360,
      segmentIndex: idx,
      overallProgress: (idx + t) / (this.routeCoords.length - 1),
      speed: this.baseSpeedKmh * this.speed,
      strayed: this.strayed,
      finished: false,
    };
  }


  // ── Cleanup ──────────────────────────────────────────
  destroy() {
    this.pause();
    this.callbacks = [];
  }
}
