/**
 * Real Device GPS Tracker (Native Capacitor Android + Web)
 * 
 * Supports native Android GPS via @capacitor/geolocation
 * with automatic fallback to standard browser geolocation.
 */

import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { haversine, bearing } from "./osmService.js";

export class RealGPSTracker {
  constructor() {
    this.watchId = null;
    this.callbacks = [];
    this.lastPos = null;
    this.isActive = false;
  }

  static isSupported() {
    return Capacitor.isNativePlatform() || (typeof navigator !== "undefined" && "geolocation" in navigator);
  }

  async requestPermission() {
    try {
      if (Capacitor.isNativePlatform()) {
        const status = await Geolocation.requestPermissions();
        return status.location === "granted";
      }
      return true;
    } catch (err) {
      console.warn("Permission request error:", err);
      return false;
    }
  }

  async start() {
    if (!RealGPSTracker.isSupported()) {
      throw new Error("Geolocation is not supported by your device/browser.");
    }

    if (this.isActive) return;
    this.isActive = true;

    // 1. Native Android App Implementation
    if (Capacitor.isNativePlatform()) {
      try {
        await this.requestPermission();
        this.watchId = await Geolocation.watchPosition(
          { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
          (pos, err) => {
            if (err || !pos) {
              console.warn("Native GPS watch error:", err);
              return;
            }
            this._processPosition(pos);
          }
        );
        return;
      } catch (err) {
        console.warn("Native watchPosition failed, falling back to web API:", err);
      }
    }

    // 2. Web Browser Implementation
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this._processPosition(pos);
      },
      (err) => {
        console.warn("Web GPS satellite watch error:", err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
      }
    );
  }

  _processPosition(pos) {
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
  }

  stop() {
    if (this.watchId !== null) {
      if (Capacitor.isNativePlatform() && typeof this.watchId === "string") {
        Geolocation.clearWatch({ id: this.watchId });
      } else if (typeof navigator !== "undefined" && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(this.watchId);
      }
      this.watchId = null;
    }
    this.isActive = false;
  }

  async getCurrentLocation() {
    if (!RealGPSTracker.isSupported()) {
      throw new Error("Geolocation not supported on this device.");
    }

    // 1. If Native Android App: Use Capacitor Native Geolocation
    if (Capacitor.isNativePlatform()) {
      try {
        await this.requestPermission();
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10000,
        });
        return {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 5),
          speed: pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0,
        };
      } catch (nativeErr) {
        console.warn("Capacitor native location error:", nativeErr);
      }
    }

    // 2. Web Browser Implementation (with high-accuracy + coarse fallback)
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 5),
          speed: pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0,
        }),
        (err) => {
          console.warn("High accuracy GPS slow/denied, trying network fallback…", err.message);
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
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  _emit(pos) {
    for (const cb of this.callbacks) {
      cb(pos);
    }
  }

  destroy() {
    this.stop();
    this.callbacks = [];
  }
}
