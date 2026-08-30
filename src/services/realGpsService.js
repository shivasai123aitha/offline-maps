/**
 * Real Device GPS Tracker
 * 
 * Connects directly to mobile phone GPS satellite hardware via
 * navigator.geolocation.watchPosition with 0ms maximumAge for instant
 * real-time movement tracking while walking or driving.
 */

import { haversine, bearing } from "./osmService.js";

export class RealGPSTracker {
  constructor() {
    this.watchId = null;
    this.callbacks = [];
    this.lastPos = null;
    this.isActive = false;
  }

  static isSupported() {
    return typeof navigator !== "undefined" && "geolocation" in navigator;
  }

  start() {
    if (!RealGPSTracker.isSupported()) {
      throw new Error("Geolocation is not supported by your device/browser.");
    }

    if (this.isActive) return;
    this.isActive = true;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const accuracy = Math.round(pos.coords.accuracy || 5);
        let speedKmh = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;
        let heading = pos.coords.heading;

        if (this.lastPos) {
          const dist = haversine(this.lastPos, { lat, lon });
          if (heading === null || heading === undefined || isNaN(heading)) {
            if (dist > 0.001) {
              heading = bearing(this.lastPos, { lat, lon });
            } else {
              heading = this.lastPos.bearing || 0;
            }
          }
        }

        const data = {
          lat,
          lon,
          accuracy,
          speed: speedKmh,
          bearing: heading || 0,
          isRealGps: true,
          strayed: false,
          timestamp: pos.timestamp,
        };

        this.lastPos = data;
        this._emit(data);
      },
      (err) => {
        console.warn("Real GPS hardware satellite error:", err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,       // Zero maximumAge forces instant live satellite fix
        timeout: 10000,
      }
    );
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isActive = false;
  }

  getCurrentLocation() {
    return new Promise((resolve, reject) => {
      if (!RealGPSTracker.isSupported()) {
        reject(new Error("Geolocation not supported on this device."));
        return;
      }

      // 1. First attempt: High-accuracy hardware GPS
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 5),
          speed: pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0,
        }),
        (err) => {
          // 2. Fallback attempt: Network/Cellular location (works instantly indoors)
          console.warn("GPS satellite fix slow or denied, trying network fallback…", err.message);
          navigator.geolocation.getCurrentPosition(
            (pos2) => resolve({
              lat: pos2.coords.latitude,
              lon: pos2.coords.longitude,
              accuracy: Math.round(pos2.coords.accuracy || 25),
              speed: 0,
            }),
            (err2) => reject(err2),
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 }
          );
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    });
  }

  onPositionUpdate(callback) {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback);
    };
  }

  _emit(data) {
    for (const cb of this.callbacks) {
      cb(data);
    }
  }

  destroy() {
    this.stop();
    this.callbacks = [];
  }
}
