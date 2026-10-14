/*
 * CPMS shared core, loaded by the 2D and 3D chiller plant panels from /custom/cpms-core.js.
 *
 * Holds the rules both views must agree on (status, thresholds, efficiency bands) and one shared
 * telemetry connection per URL that any number of panels can listen to at the same time.
 * Change a threshold here and both views pick it up on their next load.
 */
(function () {
  'use strict';

  var VERSION = 2;
  if (window.CPMS && window.CPMS.version >= VERSION) return;

  /* ═════════════ status rules ═════════════ */
  function isGoodTelemetry(item) {
    return !item || !item.telemetryQuality || item.telemetryQuality === 'GOOD';
  }
  function isRunningState(item) {
    return isGoodTelemetry(item) && (item.state === 'RUNNING' || item.state === 'STARTING' || item.state === 'OPEN');
  }
  function isTripState(device) {
    return (device && device.trip === true) || /trip/i.test(String((device && device.reason) || ''));
  }
  // FAULT reported by the device (state, health or availability) — shown with the same red alarm styling as a trip
  function isFaultState(device) {
    if (!device) return false;
    return [device.state, device.status, device.health, device.availability]
      .some(function (v) { return String(v || '').toUpperCase() === 'FAULT'; });
  }
  function isPumpRunning(pump) {
    return !!pump && pump.effectiveRun === true && Number(pump.effectiveSpeedCmd || 0) > 0;
  }
  function shortMode(mode) {
    if (mode === 'AUTO') return 'A';
    if (mode === 'MANUAL') return 'M';
    return '--';
  }

  /* ═════════════ thresholds: 'good' | 'warn' | 'bad' | 'neutral' ═════════════ */
  function numericReading(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function chillerThreshold(metric, value, chiller) {
    if (!chiller || chiller.effectiveRun !== true || chiller.telemetryGood === false) return 'neutral';
    var reading = numericReading(value);
    if (reading === null) return 'neutral';
    if (metric === 'rla') {
      if (reading < 3) return 'neutral';
      if (reading >= 105) return 'bad';
      return reading >= 80 ? 'warn' : 'good';
    }
    if (metric === 'efficiency') {
      if (reading <= 0) return 'neutral';
      if (reading > 0.78) return 'bad';
      return reading > 0.715 ? 'warn' : 'good';
    }
    if (metric === 'evapEWT') return reading <= 30 ? 'good' : 'bad';
    if (metric === 'evapLWT') {
      if (reading < 3 || reading > 20) return 'bad';
      var target = numericReading(chiller.setPoint);
      if (target === null) return 'neutral';
      return Math.abs(reading - target) <= 0.1 ? 'good' : 'warn';
    }
    if (metric === 'condEWT') return reading < 28.9 ? 'good' : 'warn';
    if (metric === 'condLWT') {
      if (reading > 45) return 'bad';
      return reading >= 40 ? 'warn' : 'good';
    }
    return 'neutral';
  }
  function headerThreshold(metric, value, header, activeSetpoint) {
    var reading = numericReading(value);
    var flowRate = numericReading(header && header.flowRate);
    if (reading === null || flowRate === null || flowRate <= 0) return 'neutral';
    if (metric === 'chws') {
      if (reading < 3 || reading > 20) return 'bad';
      var target = numericReading(activeSetpoint);
      if (target === null) return 'neutral';
      return Math.abs(reading - target) <= 0.1 ? 'good' : 'warn';
    }
    if (metric === 'chwr') return reading <= 30 ? 'good' : 'bad';
    if (metric === 'cws') return reading < 28.9 ? 'good' : 'warn';
    if (metric === 'cwr') {
      if (reading > 45) return 'bad';
      return reading >= 40 ? 'warn' : 'good';
    }
    return 'neutral';
  }

  /* ═════════════ plant efficiency bands (kW/RT) ═════════════ */
  function efficiencyRating(value) {
    var efficiency = typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (efficiency === null || efficiency <= 0) return { label: 'Unavailable', className: '' };
    if (efficiency < 0.5) return { label: 'Exceptional', className: 'good' };
    if (efficiency < 0.6) return { label: 'Excellent', className: 'good' };
    if (efficiency < 0.7) return { label: 'Good', className: 'good' };
    if (efficiency < 0.8) return { label: 'Acceptable', className: 'warn' };
    if (efficiency <= 1) return { label: 'Poor', className: 'bad' };
    return { label: 'Very poor, investigate', className: 'bad' };
  }

  function calcWetBulb(t, rh) {
    if (t == null || rh == null) return null;
    return t * Math.atan(0.151977 * Math.pow(rh + 8.313659, 0.5))
      + Math.atan(t + rh)
      - Math.atan(rh - 1.676331)
      + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh)
      - 4.686035;
  }

  /* ═════════════ shared telemetry connection ═════════════
     subscribe(url, { onMessage(payload), onStatus(state), alive() }) returns an unsubscribe function.
     state is 'connecting' | 'connected' | 'offline'. Every panel on the page gets every message; a
     listener whose alive() returns false (its panel was removed) is dropped automatically. */
  var connections = new Map();
  var pageClosing = false;
  var RECONNECT_MS = 5000;

  function call(fn, arg) {
    if (typeof fn !== 'function') return;
    try { fn(arg); } catch (err) { console.error('CPMS: telemetry listener failed', err); }
  }
  function setStatus(conn, state) {
    conn.status = state;
    conn.listeners.forEach(function (l) { call(l.onStatus, state); });
  }
  function prune(conn) {
    conn.listeners.forEach(function (l) {
      var alive = true;
      try { alive = typeof l.alive !== 'function' || l.alive() !== false; } catch (_) { alive = false; }
      if (!alive) conn.listeners.delete(l);
    });
    if (conn.listeners.size === 0) { shutdown(conn); return false; }
    return true;
  }
  function shutdown(conn) {
    clearTimeout(conn.timer);
    var ws = conn.ws;
    conn.ws = null;
    if (ws && ws.readyState < 2) { try { ws.close(1000, 'no listeners'); } catch (_) { /* ignore */ } }
    connections.delete(conn.url);
  }
  function scheduleReconnect(conn) {
    clearTimeout(conn.timer);
    conn.timer = setTimeout(function () { if (prune(conn)) open(conn); }, RECONNECT_MS);
  }
  function open(conn) {
    clearTimeout(conn.timer);
    setStatus(conn, 'connecting');
    var ws;
    try {
      ws = new WebSocket(conn.url);
    } catch (err) {
      setStatus(conn, 'offline');
      scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    ws.onopen = function () { if (conn.ws === ws) setStatus(conn, 'connected'); };
    ws.onmessage = function (event) {
      if (conn.ws !== ws || !prune(conn)) return;
      var payload;
      try { payload = JSON.parse(event.data); } catch (err) {
        console.error('CPMS: telemetry message is not valid JSON', err);
        return;
      }
      conn.listeners.forEach(function (l) { call(l.onMessage, payload); });
    };
    ws.onclose = function (event) {
      if (conn.ws !== ws) return;
      conn.ws = null;
      setStatus(conn, 'offline');
      if (pageClosing || !prune(conn)) return;
      console.warn('CPMS: telemetry connection closed' + (event && event.reason ? ' (' + event.reason + ')' : '') + ', reconnecting in 5 s');
      scheduleReconnect(conn);
    };
    ws.onerror = function () { try { ws.close(); } catch (_) { /* ignore */ } };
  }
  function subscribe(url, listener) {
    var conn = connections.get(url);
    if (!conn) {
      conn = { url: url, ws: null, listeners: new Set(), status: 'connecting', timer: null };
      connections.set(url, conn);
    }
    conn.listeners.add(listener);
    call(listener.onStatus, conn.status);
    if (!conn.ws) open(conn);   // first listener, or waiting to reconnect: connect now
    return function unsubscribe() {
      conn.listeners.delete(listener);
      if (conn.listeners.size === 0) shutdown(conn);
    };
  }
  function closeAll(reason) {
    pageClosing = true;
    connections.forEach(function (conn) {
      clearTimeout(conn.timer);
      if (conn.ws && conn.ws.readyState < 2) { try { conn.ws.close(1000, reason); } catch (_) { /* ignore */ } }
    });
  }
  window.addEventListener('pagehide', function () { closeAll('pagehide'); });
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;               // restored from back/forward cache: reconnect
    pageClosing = false;
    connections.forEach(function (conn) { if (!conn.ws) open(conn); });
  });

  window.CPMS = {
    version: VERSION,
    rules: {
      isGoodTelemetry: isGoodTelemetry,
      isRunningState: isRunningState,
      isTripState: isTripState,
      isFaultState: isFaultState,
      isPumpRunning: isPumpRunning,
      shortMode: shortMode,
      numericReading: numericReading,
      chillerThreshold: chillerThreshold,
      headerThreshold: headerThreshold,
      efficiencyRating: efficiencyRating,
      calcWetBulb: calcWetBulb,
    },
    telemetry: { subscribe: subscribe },
  };
})();
