/**
 * Network Monitor
 *
 * Tracks network connectivity state and provides
 * simulation controls for testing offline behavior.
 */


// Network states
export const NET_STATE = {
  ONLINE: "online",
  OFFLINE: "offline",
  TRANSITION: "transition",  // brief state during switch
  RECOVERY: "recovery",      // reconnecting after offline period
};


export class NetworkMonitor {

  constructor() {
    this.state = navigator.onLine ? NET_STATE.ONLINE : NET_STATE.OFFLINE;
    this.simulated = false;       // true if offline state is user-simulated
    this.callbacks = [];
    this.offlineSince = null;
    this.transitionTimer = null;

    // Listen to real browser online/offline events
    this._onOnline = () => {
      if (!this.simulated) this._transition(NET_STATE.ONLINE);
    };
    this._onOffline = () => {
      if (!this.simulated) this._transition(NET_STATE.OFFLINE);
    };

    window.addEventListener("online", this._onOnline);
    window.addEventListener("offline", this._onOffline);
  }


  // ── Subscribe ─────────────────────────────────────────
  onChange(callback) {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback);
    };
  }

  _emit() {
    const info = this.getInfo();
    for (const cb of this.callbacks) cb(info);
  }


  // ── State transition with brief intermediate state ────
  _transition(targetState) {
    if (this.transitionTimer) clearTimeout(this.transitionTimer);

    // Show transition state briefly
    const intermediateState = targetState === NET_STATE.ONLINE
      ? NET_STATE.RECOVERY
      : NET_STATE.TRANSITION;

    this.state = intermediateState;
    this._emit();

    this.transitionTimer = setTimeout(() => {
      this.state = targetState;
      if (targetState === NET_STATE.OFFLINE) {
        this.offlineSince = Date.now();
      } else {
        this.offlineSince = null;
      }
      this._emit();
    }, 800);
  }


  // ── Simulate internet loss ───────────────────────────
  simulateOffline() {
    this.simulated = true;
    this._transition(NET_STATE.OFFLINE);
  }

  simulateOnline() {
    this.simulated = true;
    this._transition(NET_STATE.ONLINE);
  }

  toggleSimulation() {
    if (this.state === NET_STATE.ONLINE || this.state === NET_STATE.RECOVERY) {
      this.simulateOffline();
    } else {
      this.simulateOnline();
    }
  }

  // Reset to real network state
  resetSimulation() {
    this.simulated = false;
    this.state = navigator.onLine ? NET_STATE.ONLINE : NET_STATE.OFFLINE;
    this.offlineSince = this.state === NET_STATE.OFFLINE ? Date.now() : null;
    this._emit();
  }


  // ── Get current state info ───────────────────────────
  getInfo() {
    const offlineDurationMs = this.offlineSince
      ? Date.now() - this.offlineSince
      : 0;

    return {
      state: this.state,
      isOnline: this.state === NET_STATE.ONLINE || this.state === NET_STATE.RECOVERY,
      isOffline: this.state === NET_STATE.OFFLINE || this.state === NET_STATE.TRANSITION,
      isTransitioning: this.state === NET_STATE.TRANSITION || this.state === NET_STATE.RECOVERY,
      simulated: this.simulated,
      offlineDurationMs,
      label: this._label(),
      color: this._color(),
    };
  }

  _label() {
    switch (this.state) {
      case NET_STATE.ONLINE: return "Online";
      case NET_STATE.OFFLINE: return "Offline";
      case NET_STATE.TRANSITION: return "Losing Connection…";
      case NET_STATE.RECOVERY: return "Reconnecting…";
      default: return "Unknown";
    }
  }

  _color() {
    switch (this.state) {
      case NET_STATE.ONLINE: return "#22c55e";
      case NET_STATE.OFFLINE: return "#ef4444";
      case NET_STATE.TRANSITION: return "#f59e0b";
      case NET_STATE.RECOVERY: return "#3b82f6";
      default: return "#9ca3af";
    }
  }


  // ── Cleanup ──────────────────────────────────────────
  destroy() {
    window.removeEventListener("online", this._onOnline);
    window.removeEventListener("offline", this._onOffline);
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.callbacks = [];
  }
}
