import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.13.0/dist/maplibre-gl.mjs';
import { CENTER, REGION, DEFAULTS, ZONE_CLASSES, CAR_COLORS, FADE_OUTER_METERS } from './src/config.js';
import {
  tileBounds, intersects, parseTileZXY,
  centerOfCoordinates, geometryCenter,
  zoneCircleCoords, haversineMeters,
  lngLatToTile, numToLetters, displayHeight,
  canonicalZoneClass, parseZoneArgs, parseBuildingArgs
} from './src/helpers.js';
import {
  preparePath, stitchRoadSegments, randomCarColor, samplePathPosition, carRect
} from './src/traffic.js';
import {
  syntheticBuildingId, buildingKey, customBuildingFeature,
  mapBuildingLabelPosition, buildingLabelText, buildingLabelAnchor
} from './src/buildings.js';
import { createDebugController } from './src/debug.js';
import { createWeatherController } from './src/weather.js';
import { createParkController } from './src/parks.js';
import { createMapOverlayHelpers } from './src/map-overlays.js';
import { createRoadLayerController } from './src/road-layers.js';

  const MAX_BUILDING_LABELS = 10000;
  const CUSTOM_BUILDINGS_STORAGE_KEY = 'maplibre-custom-buildings-v1';

  const state = { ...DEFAULTS };

  const statusEl = document.getElementById('status');
  const statusBodyEl = document.getElementById('status-body');
  const statusToggleEl = document.getElementById('status-toggle');
  const overlayEl = document.getElementById('visibility-overlay');
  const { dbg, setExpanded } = createDebugController({ statusEl, statusBodyEl, statusToggleEl });
  statusToggleEl.addEventListener('click', e => {
      e.stopPropagation(); setExpanded(!statusEl.classList.contains('expanded'));
  });
  document.getElementById('status-header').addEventListener('click', () => {
      setExpanded(!statusEl.classList.contains('expanded'));
  });

  let allowedTiles = 0, blockedTiles = 0, lastReport = 0;
  function reportTileStats(force) {
      const now = Date.now();
      if (!force && now - lastReport < 1000) return;
      lastReport = now;
      dbg(`Tiles: allowed=${allowedTiles} blocked=${blockedTiles}`);
  }

  const map = new maplibregl.Map({
      style: `https://tiles.openfreemap.org/styles/bright`,
      center: CENTER,
      zoom: 18,
      pitch: 60,
      bearing: 0,
      container: 'map',
      maxBounds: [[REGION[0], REGION[1]], [REGION[2], REGION[3]]],
      minZoom: 15,
      maxZoom: 19,
      canvasContextAttributes: {antialias: true},
      transformRequest: (url, resourceType) => {
          if (resourceType !== 'Tile') return { url };
          const t = parseTileZXY(url);
          if (!t) return { url };
          const tb = tileBounds(t.z, t.x, t.y);
          if (intersects(tb, REGION)) { allowedTiles++; reportTileStats(false); return { url }; }
          blockedTiles++; reportTileStats(false);
          return { url: 'data:application/x-protobuf;base64,' };
      }
  });
  window.map = map;

  const labeledBuildings = new Map();
  const highlightedBuildings = new Map();
  const hiddenBuildingKeys = new Set();
  const buildingSnapshots = new Map();

  const hiddenTiles = new Map();
  let tilePickerActive = false;

  const drawnRoads = new Map();
  let roadDrawActive = false;
  let draftCoords = [];
  let draftCursor = null;
  let roadDrawColor = '#ff0000';
  let roadDrawWidth = 6;
  let roadIdCounter = 0;

  let roadDeleteActive = false;
  let hoveredDeleteRoadId = null;

  const customBuildings = new Map();
  let buildingDrawActive = false;
  let buildingEditActive = false;
  let buildingDraftCoords = [];
  let buildingDraftCursor = null;
  let buildingIdCounter = 0;
  let buildingDefaultHeight = 20;
  let buildingDefaultColor = '#7ef29d';
  let selectedBuildingId = null;
  let buildingDragState = null;
  let suppressNextMapClick = false;

  let buildingDeleteActive = false;
  let hoveredDeleteBuilding = null;
  let pendingBuilding = null;

  const zones = new Map();
  let zoneIdCounter = 0;
  let zoneDrawActive = false;
  let zoneDraftCenter = null;
  let zoneDraftRadiusM = 0;
  let zoneDeleteActive = false;
  let hoveredDeleteZoneId = null;
  let pendingZone = null;
  let zoneDefaultClass = 'Flood';

  const ZONE_STORAGE_KEY = 'maplibre-custom-zones-v1';

  let cachedOsmFeatures = [];
  let cachedOsmVisibleEntries = [];

  // ============================================================
  // Traffic system (native MapLibre fill-extrusion cars)
  // ============================================================
  const VEHICLE_CLASSES = new Set([
      'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
      'minor', 'service', 'residential', 'street', 'street_limited',
      'track', 'busway', 'bus_guideway', 'raceway'
  ]);
  const ROAD_SOURCE_LAYERS = ['transportation', 'road', 'roads'];

  const roadPaths = new Map();
  let roadPathCounter = 0;
  let carIdCounter = 0;
  const trafficCars = [];
  let trafficTargetCount = 0;
  let trafficRafId = null;
  let trafficLastT = 0;

  // ---- Traffic extraction ----
  function vectorTileSourceIds() {
      const ids = [];
      const seen = new Set();
      const add = (id) => {
          if (!id || seen.has(id) || !map.getSource(id)) return;
          seen.add(id);
          ids.push(id);
      };
      add('openmaptiles');
      add('openfreemap');
      try {
          const sources = map.getStyle().sources || {};
          for (const [id, src] of Object.entries(sources)) {
              if (src && src.type === 'vector') add(id);
          }
      } catch (e) {}
      return ids;
  }

  function transportationSourceLayers() {
      const layers = new Set(['transportation']);
      try {
          for (const layer of map.getStyle().layers || []) {
              if (layer.type !== 'line') continue;
              const sl = layer['source-layer'];
              if (sl && /transportation|road|street|highway/i.test(sl)) layers.add(sl);
          }
      } catch (e) {}
      for (const sl of ROAD_SOURCE_LAYERS) layers.add(sl);
      return [...layers];
  }

  function ensureRoadLoaderLayer() {
      if (map.getLayer('roads-loader')) return;
      const sourceId = vectorTileSourceIds()[0];
      if (!sourceId) return;
      const sourceLayer = transportationSourceLayers()[0] || 'transportation';
      try {
          map.addLayer({
              id: 'roads-loader',
              type: 'line',
              source: sourceId,
              'source-layer': sourceLayer,
              minzoom: 13,
              paint: { 'line-opacity': 0, 'line-width': 1 }
          });
          dbg(`Road loader: source=${sourceId} layer=${sourceLayer}`);
      } catch (e) {
          dbg('roads-loader failed: ' + e.message);
      }
  }

  function collectLineSegments(feats, segments, seen, classCounts) {
      for (const f of feats) {
          if (!f.geometry) continue;
          const props = f.properties || {};
          const cls = props.class || props.subclass || props.highway || props.type;
          if (cls) classCounts.set(cls, (classCounts.get(cls) || 0) + 1);
          if (!cls || !VEHICLE_CLASSES.has(cls)) continue;
          const g = f.geometry;
          const lines = g.type === 'LineString' ? [g.coordinates]
                      : g.type === 'MultiLineString' ? g.coordinates
                      : [];
          for (const line of lines) {
              if (!line || line.length < 2) continue;
              const a = line[0], b = line[line.length - 1];
              if (!a || !b || a.length < 2 || b.length < 2) continue;
              const sig = `${cls}|${a[0].toFixed(5)},${a[1].toFixed(5)}|${b[0].toFixed(5)},${b[1].toFixed(5)}|${line.length}`;
              if (seen.has(sig)) continue;
              seen.add(sig);
              segments.push({ coords: line, cls });
          }
      }
  }

  function extractRoadPathsFromTiles() {
      ensureRoadLoaderLayer();
      const segments = [];
      const seen = new Set();
      const classCounts = new Map();
      let queried = 0;

      const sourceIds = vectorTileSourceIds();
      const sourceLayers = transportationSourceLayers();
      for (const sourceId of sourceIds) {
          for (const sourceLayer of sourceLayers) {
              let feats;
              try {
                  feats = map.querySourceFeatures(sourceId, { sourceLayer });
              } catch (e) {
                  continue;
              }
              if (!feats || !feats.length) continue;
              queried += feats.length;
              collectLineSegments(feats, segments, seen, classCounts);
          }
      }

      if (segments.length === 0) {
          try {
              const rendered = map.queryRenderedFeatures({ layers: (map.getStyle().layers || [])
                  .filter(l => l.type === 'line' && l['source-layer'] && /transportation|road|street|highway/i.test(l['source-layer']))
                  .map(l => l.id) });
              queried += rendered.length;
              collectLineSegments(rendered, segments, seen, classCounts);
          } catch (e) {
              dbg('road rendered query failed: ' + e.message);
          }
      }

      for (const r of drawnRoads.values()) {
          if (r.coords && r.coords.length >= 2) {
              segments.push({ coords: r.coords, cls: 'street' });
          }
      }

      const stitched = stitchRoadSegments(segments);
      roadPaths.clear();
      roadPathCounter = 0;
      for (const s of stitched) {
          const p = preparePath(s.coords, s.cls);
          if (p.length >= 20) roadPaths.set(p.id, p);
      }
      const el = document.getElementById('traffic-roads');
      if (el) el.textContent = roadPaths.size;
      const classSummary = [...classCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([k, v]) => `${k}:${v}`).join(',') || 'none';
      dbg(`Traffic: ${roadPaths.size} paths from ${segments.length} segs (${queried} feats, classes ${classSummary}).`);
      return roadPaths.size;
  }

  function spawnCar() {
      const entries = [...roadPaths.values()].filter(p => p.length >= 40);
      if (entries.length === 0) return null;
      const totalLen = entries.reduce((s, p) => s + p.length, 0);
      let pick = Math.random() * totalLen;
      let chosen = entries[0];
      for (const p of entries) {
          pick -= p.length;
          if (pick <= 0) { chosen = p; break; }
      }
      const direction = Math.random() < 0.5 ? 1 : -1;
      return {
          id: `car-${++carIdCounter}`,
          pathId: chosen.id,
          t: Math.random() * chosen.length,
          speed: 8 + Math.random() * 8,
          direction,
          laneOffset: -direction * 1.8,
          color: randomCarColor(),
          pos: [0, 0, 0],
          heading: 0
      };
  }

  function adjustTrafficCount(target) {
      while (trafficCars.length < target) {
          const c = spawnCar();
          if (!c) break;
          trafficCars.push(c);
      }
      while (trafficCars.length > target) trafficCars.pop();
      const el = document.getElementById('traffic-count');
      if (el) el.textContent = String(trafficCars.length);
      updateTrafficLayer();
  }

  function animateTraffic(now) {
      const dt = Math.min(0.1, (now - trafficLastT) / 1000 || 0);
      trafficLastT = now;
      for (const car of trafficCars) {
          const path = roadPaths.get(car.pathId);
          if (!path) continue;
          car.t += car.speed * car.direction * dt;
          if (car.t < 0) car.t += path.length;
          if (car.t > path.length) car.t -= path.length;
          const s = samplePathPosition(path, car.t, car.direction, car.laneOffset);
          car.pos = s.pos;
          car.heading = s.heading;
      }
      updateTrafficLayer();
      trafficRafId = requestAnimationFrame(animateTraffic);
  }

  function updateTrafficLayer() {
      const src = map.getSource('traffic-cars-src');
      if (!src) return;
      const features = [];
      for (const car of trafficCars) {
          const [r, g, b] = car.color;
          const col = `rgb(${r},${g},${b})`;
          features.push({
              type: 'Feature',
              properties: { part: 'body', color: col },
              geometry: { type: 'Polygon', coordinates: [carRect(car, 0, 4.2, 1.8)] }
          });
          features.push({
              type: 'Feature',
              properties: { part: 'cabin', color: '#1f2937' },
              geometry: { type: 'Polygon', coordinates: [carRect(car, -0.3, 2.2, 1.6)] }
          });
      }
      src.setData({ type: 'FeatureCollection', features });
  }

  function setupTrafficOverlay() {
      if (map.getSource('traffic-cars-src')) return;
      map.addSource('traffic-cars-src', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
          id: 'traffic-cars-body',
          type: 'fill-extrusion',
          source: 'traffic-cars-src',
          filter: ['==', ['get', 'part'], 'body'],
          paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-base': 0.3,
              'fill-extrusion-height': 1.0,
              'fill-extrusion-opacity': 1
          }
      });
      map.addLayer({
          id: 'traffic-cars-cabin',
          type: 'fill-extrusion',
          source: 'traffic-cars-src',
          filter: ['==', ['get', 'part'], 'cabin'],
          paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-base': 1.0,
              'fill-extrusion-height': 1.5,
              'fill-extrusion-opacity': 1
          }
      });
      dbg('Traffic: car layers created.');
  }

  function startTrafficAnimation() {
      if (trafficRafId !== null) return;
      trafficLastT = performance.now();
      trafficRafId = requestAnimationFrame(animateTraffic);
      dbg('Traffic: animation started.');
  }

  function bindTrafficSlider() {
      const slider = document.getElementById('traffic-slider');
      if (!slider) return;
      slider.addEventListener('input', () => {
          trafficTargetCount = parseInt(slider.value, 10) || 0;
          if (roadPaths.size === 0) extractRoadPathsFromTiles();
          adjustTrafficCount(trafficTargetCount);
          if (trafficTargetCount > 0) {
              setupTrafficOverlay();
              startTrafficAnimation();
          }
      });
  }

  function setTrafficCount(n) {
      const v = Math.max(0, Math.min(200, Math.round(n)));
      trafficTargetCount = v;
      const slider = document.getElementById('traffic-slider');
      if (slider) slider.value = String(v);
      if (roadPaths.size === 0) extractRoadPathsFromTiles();
      adjustTrafficCount(v);
      if (v > 0) {
          setupTrafficOverlay();
          startTrafficAnimation();
      }
      return v;
  }

  const keyToLetter = new Map();
  const letterToKey = new Map();
  let nextLetterIndex = 0;
  function resetLetters() {
      keyToLetter.clear();
      letterToKey.clear();
      nextLetterIndex = 0;
  }

  let currentVisibleBuildings = [];

  let DETECTED_FONT_STACK = null;
  function detectFontStack() {
      if (DETECTED_FONT_STACK) return DETECTED_FONT_STACK;
      for (const layer of map.getStyle().layers) {
          if (layer.type === 'symbol' && layer.layout && layer.layout['text-font']) {
              const f = layer.layout['text-font'];
              if (Array.isArray(f) && f.length) {
                  DETECTED_FONT_STACK = f;
                  dbg(`Detected font stack: ${JSON.stringify(f)}`);
                  return f;
              }
          }
      }
      DETECTED_FONT_STACK = ['Noto Sans Regular'];
      dbg('No font stack detected; defaulting to Noto Sans Regular.');
      return DETECTED_FONT_STACK;
  }

  function setupLiveBuildingsLayer() {
      if (map.getLayer('buildings-live')) return;
      if (!map.getSource('openfreemap')) {
          map.addSource('openfreemap', {
              url: `https://tiles.openfreemap.org/planet`,
              type: 'vector'
          });
      }
      if (!map.getLayer('buildings-loader')) {
          map.addLayer({
              id: 'buildings-loader',
              type: 'fill-extrusion',
              source: 'openfreemap',
              'source-layer': 'building',
              'minzoom': 15,
              'filter': ['!=', ['get', 'hide_3d'], true],
              paint: {
                  'fill-extrusion-opacity': 0,
                  'fill-extrusion-height': [
                      'interpolate', ['linear'], ['zoom'],
                      15, 0, 16, ['get', 'render_height']
                  ],
                  'fill-extrusion-base': [
                      'interpolate', ['linear'], ['zoom'],
                      15, 0, 16, ['get', 'render_min_height']
                  ]
              }
          });
      }
      map.addSource('buildings-live-src', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
      });
      map.addSource('buildings-shadow-src', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
          id: 'buildings-shadow',
          type: 'fill',
          source: 'buildings-shadow-src',
          paint: {
              'fill-color': '#000000',
              'fill-opacity': 0.45,
              'fill-translate': [state.aoOffset, state.aoOffset]
          }
      });
      map.addLayer({
          id: 'buildings-live',
          type: 'fill-extrusion',
          source: 'buildings-live-src',
          minzoom: 15,
          paint: {
              'fill-extrusion-color': [
                  'case',
                  ['has', 'custom_color'],
                  ['get', 'custom_color'],
                  ['interpolate', ['linear'], ['get', 'render_height'],
                      0, 'lightgray', 200, 'royalblue', 400, 'lightblue']
              ],
              'fill-extrusion-height': [
                  'interpolate', ['linear'], ['get', 'render_height'],
                  0, 3, 200, 200
              ],
              'fill-extrusion-base': ['get', 'render_min_height'],
              'fill-extrusion-vertical-gradient': true
          }
      });
      dbg('Live buildings + shadow layers created.');
  }

  function applyAmbientOcclusion() {
      if (!map.getLayer('buildings-shadow')) return;
      map.setLayoutProperty('buildings-shadow', 'visibility',
          state.ambientOcclusion ? 'visible' : 'none');
      map.setPaintProperty('buildings-shadow', 'fill-opacity',
          state.ambientOcclusion ? state.aoIntensity : 0);
      map.setPaintProperty('buildings-shadow', 'fill-translate',
          [state.aoOffset, state.aoOffset]);
      const btn = document.getElementById('ao-toggle-btn');
      if (btn) {
          btn.textContent = state.ambientOcclusion ? '🌑 Shadows ON' : '☀️ Shadows OFF';
          btn.classList.toggle('active', state.ambientOcclusion);
      }
      dbg(`Shadows: ${state.ambientOcclusion ? 'ON' : 'OFF'} (i=${state.aoIntensity}, o=${state.aoOffset}px)`);
  }

  function refreshBuildings() {
      if (!map.getSource('openfreemap')) return;
      let features = [];
      try {
          features = map.querySourceFeatures('openfreemap', { sourceLayer: 'building' });
      } catch (e) {
          dbg('building query failed: ' + e.message);
          return;
      }
      const exploded = [];
      for (const f of features) {
          if (!f.geometry) continue;
          if (f.geometry.type === 'Polygon') exploded.push(f);
          else if (f.geometry.type === 'MultiPolygon') {
              for (const polyCoords of f.geometry.coordinates) {
                  exploded.push({
                      type: 'Feature',
                      properties: f.properties,
                      geometry: { type: 'Polygon', coordinates: polyCoords }
                  });
              }
          }
      }
      const seen = new Set();
      cachedOsmFeatures = [];
      cachedOsmVisibleEntries = [];
      for (const f of exploded) {
          const key = buildingKey(f);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const center = geometryCenter(f.geometry);
          const height = (f.properties && f.properties.render_height) || 12;
          const base = (f.properties && f.properties.render_min_height) || 0;
          const osmId = (f.properties && (f.properties.osm_id || f.properties.id)) || null;
          if (center && !buildingSnapshots.has(key)) {
              buildingSnapshots.set(key, { key, xy: center, feature: f, osmId, height, base });
          }
          if (hiddenBuildingKeys.has(key)) continue;
          if (!highlightedBuildings.has(key)) {
              cachedOsmFeatures.push({
                  type: 'Feature',
                  properties: { render_height: height, render_min_height: base },
                  geometry: f.geometry
              });
          }
          if (center) {
              cachedOsmVisibleEntries.push({ xy: center, feature: f, key, osmId, height, base });
          }
      }
      rebuildBuildingsSource();
      if (highlightedBuildings.size) rebuildHighlights();
      dbg(`refreshBuildings: ${cachedOsmFeatures.length} OSM + ${customBuildings.size} custom (${cachedOsmVisibleEntries.length} usable).`);
  }

  function rebuildBuildingsSource() {
      const drawFeatures = cachedOsmFeatures.slice();
      const visibleEntries = cachedOsmVisibleEntries.slice();
      for (const b of customBuildings.values()) {
          const key = `custom_${b.id}`;
          if (hiddenBuildingKeys.has(key)) continue;
          const feature = customBuildingFeature(b);
          const center = centerOfCoordinates(b.coords);
          if (highlightedBuildings.has(key)) {
              const h = highlightedBuildings.get(key);
              h.feature = feature;
              h.height = b.height;
              h.base = b.base;
          } else {
              drawFeatures.push(feature);
          }
          if (center) {
              visibleEntries.push({ xy: center, feature, key, osmId: null, height: b.height, base: b.base });
          }
      }
      currentVisibleBuildings = visibleEntries;
      const src = map.getSource('buildings-live-src');
      if (src) src.setData({ type: 'FeatureCollection', features: drawFeatures });
      const shadowSrc = map.getSource('buildings-shadow-src');
      if (shadowSrc) {
          shadowSrc.setData({
              type: 'FeatureCollection',
              features: drawFeatures.map(f => ({
                  type: 'Feature',
                  properties: {},
                  geometry: f.geometry
              }))
          });
      }
  }

  let refreshDebounce = null;
  function scheduleRefreshBuildings(delayMs = 300) {
      clearTimeout(refreshDebounce);
      refreshDebounce = setTimeout(() => {
          refreshBuildings();
          if (state.buildingLabels) updateBuildingLabels();
          extractRoadPathsFromTiles();
          if (trafficTargetCount > 0) adjustTrafficCount(trafficTargetCount);
      }, delayMs);
  }

  let initialPopulateDone = false;
  map.on('idle', () => {
      if (initialPopulateDone) return;
      initialPopulateDone = true;
      refreshBuildings();
      if (state.buildingLabels) updateBuildingLabels();
  });
  map.on('moveend', () => scheduleRefreshBuildings(300));

  function applyRoads() {
      let casings = 0, fills = 0;
      for (const layer of map.getStyle().layers) {
          if (layer.type !== 'line') continue;
          const sl = layer['source-layer'];
          if (!sl || !/transportation|road|street|highway/i.test(sl)) continue;
          const id = String(layer.id || '').toLowerCase();
          const isCasing = /casing|outline|border|edge/.test(id);
          if (isCasing) {
              map.setPaintProperty(layer.id, 'line-color', state.casingColor);
              map.setPaintProperty(layer.id, 'line-opacity', state.casingOpacity);
              casings++;
          } else {
              map.setPaintProperty(layer.id, 'line-color', state.roadFill);
              map.setPaintProperty(layer.id, 'line-opacity', state.roadOpacity);
              fills++;
          }
      }
      dbg(`Roads: fills=${fills} casings=${casings}`);
  }

  function applyBuildings() {
      const vis = state.buildings ? 'visible' : 'none';
      if (map.getLayer('buildings-live')) map.setLayoutProperty('buildings-live', 'visibility', vis);
      if (map.getLayer('buildings-shadow')) {
          map.setLayoutProperty('buildings-shadow', 'visibility',
              state.buildings && state.ambientOcclusion ? 'visible' : 'none');
      }
      if (map.getLayer('building-labels')) map.setLayoutProperty('building-labels', 'visibility', vis);
      if (map.getLayer('building-highlights')) map.setLayoutProperty('building-highlights', 'visibility', vis);
      dbg(`Buildings: ${state.buildings ? 'visible' : 'hidden'}`);
  }

  function applyLabels() {
      for (const layer of map.getStyle().layers) {
          if (layer.type === 'symbol' && layer.id !== 'building-labels' && layer.id !== 'zone-labels') {
              map.setLayoutProperty(layer.id, 'visibility', state.labels ? 'visible' : 'none');
          }
      }
      dbg(`Map labels: ${state.labels ? 'visible' : 'hidden'}`);
  }

  const info = document.getElementById('info');
  function updateInfo() {
      const c = map.getCenter();
      info.textContent =
          `lng: ${c.lng.toFixed(6)}\nlat: ${c.lat.toFixed(6)}\n` +
          `zoom: ${map.getZoom().toFixed(2)}\npitch: ${map.getPitch().toFixed(1)}\n` +
          `bearing: ${map.getBearing().toFixed(1)}`;
  }
  map.on('move', updateInfo);
  map.on('load', updateInfo);

  function updateBuildingLabels() {
      if (!state.buildingLabels) return;
      const entries = currentVisibleBuildings.slice();
      entries.sort((a, b) => {
          const dy = b.xy[1] - a.xy[1];
          if (Math.abs(dy) > 1e-5) return dy;
          return a.xy[0] - b.xy[0];
      });
      const trimmed = entries.slice(0, MAX_BUILDING_LABELS);
      labeledBuildings.clear();
      const labelFeatures = [];
      const seenKeys = new Set();
      for (const e of trimmed) {
          const existingLetter = keyToLetter.get(e.key);
          if (existingLetter) {
              labeledBuildings.set(existingLetter, { ...e, letter: existingLetter });
              labelFeatures.push({
                  type: 'Feature',
                  properties: { letter: existingLetter },
                  geometry: { type: 'Point', coordinates: e.xy }
              });
              seenKeys.add(e.key);
          }
      }
      for (const e of trimmed) {
          if (seenKeys.has(e.key)) continue;
          let letter;
          do { letter = numToLetters(nextLetterIndex++); } while (letterToKey.has(letter));
          keyToLetter.set(e.key, letter);
          letterToKey.set(letter, e.key);
          labeledBuildings.set(letter, { ...e, letter });
          labelFeatures.push({
              type: 'Feature',
              properties: { letter },
              geometry: { type: 'Point', coordinates: e.xy }
          });
      }
      const data = { type: 'FeatureCollection', features: labelFeatures };
      if (map.getSource('building-labels-src')) {
          map.getSource('building-labels-src').setData(data);
      } else {
          map.addSource('building-labels-src', { type: 'geojson', data });
      }
      if (!map.getLayer('building-labels')) {
          const fontStack = detectFontStack();
          map.addLayer({
              id: 'building-labels',
              type: 'symbol',
              source: 'building-labels-src',
              layout: {
                  'text-field': ['get', 'letter'],
                  'text-font': fontStack,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 15, 11, 18, 18, 19, 22],
                  'text-allow-overlap': true,
                  'text-ignore-placement': true,
                  'text-rotation-alignment': 'viewport',
                  'text-pitch-alignment': 'viewport'
              },
              paint: {
                  'text-color': '#ffffff',
                  'text-halo-color': '#0b1220',
                  'text-halo-width': 2.5,
                  'text-halo-blur': 0.5
              }
          });
      }
      map.setLayoutProperty('building-labels', 'visibility',
          state.buildings ? 'visible' : 'none');
      dbg(`Labels: ${labelFeatures.length} (of ${entries.length}).`);
  }

  function rebuildHighlights() {
      const features = [];
      const shadowFeatures = [];
      for (const h of highlightedBuildings.values()) {
          features.push({
              type: 'Feature',
              properties: { color: h.color, height: displayHeight(h.height), base: h.base },
              geometry: h.feature.geometry
          });
          shadowFeatures.push({
              type: 'Feature',
              properties: {},
              geometry: h.feature.geometry
          });
      }
      const data = { type: 'FeatureCollection', features };
      if (map.getSource('building-highlights-src')) {
          map.getSource('building-highlights-src').setData(data);
      } else if (features.length) {
          map.addSource('building-highlights-src', { type: 'geojson', data });
          map.addLayer({
              id: 'building-highlights',
              type: 'fill-extrusion',
              source: 'building-highlights-src',
              paint: {
                  'fill-extrusion-color': ['get', 'color'],
                  'fill-extrusion-height': ['get', 'height'],
                  'fill-extrusion-base': ['get', 'base'],
                  'fill-extrusion-opacity': 1,
                  'fill-extrusion-vertical-gradient': false
              }
          });
      }
      const shadowSrc = map.getSource('buildings-shadow-src');
      if (shadowSrc && map.getSource('buildings-live-src')) {
          const liveData = map.getSource('buildings-live-src')._data || { features: [] };
          const base = [];
          for (const f of liveData.features || []) {
              base.push({ type: 'Feature', properties: {}, geometry: f.geometry });
          }
          for (const s of shadowFeatures) base.push(s);
          shadowSrc.setData({ type: 'FeatureCollection', features: base });
      }
  }

  function lookupBuilding(letterRaw) {
      const letter = String(letterRaw || '').trim().toUpperCase();
      if (!state.buildingLabels) {
          logPrompt('error', 'Turn on labels first: "label buildings"');
          return null;
      }
      const entry = labeledBuildings.get(letter);
      if (!entry) {
          logPrompt('error', `No building labeled "${letter}" in view.`);
          return null;
      }
      return entry;
  }

  function highlightBuilding(letterRaw, color) {
      const entry = lookupBuilding(letterRaw);
      if (!entry) return;
      highlightedBuildings.set(entry.key, {
          letter: entry.letter,
          color: color || '#ff2d2d',
          feature: entry.feature,
          height: entry.height,
          base: entry.base
      });
      rebuildHighlights();
      refreshBuildings();
      logPrompt('bot', `Building ${entry.letter} highlighted.`);
  }
  function unhighlightBuilding(letterRaw) {
      const entry = lookupBuilding(letterRaw);
      if (!entry) return;
      if (highlightedBuildings.delete(entry.key)) {
          rebuildHighlights();
          refreshBuildings();
          logPrompt('bot', `Highlight removed from ${entry.letter}.`);
      } else {
          logPrompt('info', `Building ${entry.letter} wasn't highlighted.`);
      }
  }
  function clearHighlights() {
      highlightedBuildings.clear();
      if (map.getLayer('building-highlights')) map.removeLayer('building-highlights');
      if (map.getSource('building-highlights-src')) map.removeSource('building-highlights-src');
      refreshBuildings();
      logPrompt('bot', 'All highlights cleared.');
  }

  function hideBuildingByLetter(letterRaw) {
      const entry = lookupBuilding(letterRaw);
      if (!entry) return;
      hiddenBuildingKeys.add(entry.key);
      highlightedBuildings.delete(entry.key);
      rebuildHighlights();
      refreshBuildings();
      updateBuildingLabels();
      logPrompt('bot', `Building ${entry.letter} hidden.`);
  }
  function showBuildingByLetter(letterRaw) {
      const letter = String(letterRaw || '').trim().toUpperCase();
      const keyToShow = letterToKey.get(letter);
      if (!keyToShow) {
          logPrompt('error', `No building is currently assigned letter "${letter}".`);
          return;
      }
      if (!hiddenBuildingKeys.has(keyToShow)) {
          logPrompt('info', `Building ${letter} is already visible.`);
          return;
      }
      hiddenBuildingKeys.delete(keyToShow);
      refreshBuildings();
      updateBuildingLabels();
      logPrompt('bot', `Building ${letter} shown again.`);
  }
  function listHidden() {
      if (!hiddenBuildingKeys.size) { logPrompt('info', 'Nothing hidden.'); return; }
      logPrompt('info', `Hidden buildings: ${hiddenBuildingKeys.size}`);
      for (const k of hiddenBuildingKeys) {
          logPrompt('info', `  ${keyToLetter.get(k) || '?'}  ${k}`);
      }
  }
  function clearHidden() {
      if (!hiddenBuildingKeys.size) { logPrompt('info', 'Nothing hidden.'); return; }
      const n = hiddenBuildingKeys.size;
      hiddenBuildingKeys.clear();
      refreshBuildings();
      updateBuildingLabels();
      logPrompt('bot', `${n} hidden building(s) restored.`);
  }
  function focusBuilding(letterRaw) {
      const entry = lookupBuilding(letterRaw);
      if (!entry) return;
      const [lon, lat] = entry.xy;
      map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 18.5), duration: 900 });
      logPrompt('bot', `Flying to ${entry.letter} at ${lat.toFixed(5)}, ${lon.toFixed(5)}.`);
  }
  function infoAboutBuilding(letterRaw) {
      const entry = lookupBuilding(letterRaw);
      if (!entry) return;
      const [lon, lat] = entry.xy;
      const f = entry.feature;
      const cosLat = Math.cos(lat * Math.PI / 180);
      const mLon = 111320 * cosLat, mLat = 111320;
      let coords = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0]
                 : f.geometry.coordinates[0][0];
      let area2 = 0;
      for (let i = 0; i < coords.length - 1; i++) {
          const [x1, y1] = coords[i], [x2, y2] = coords[i+1];
          area2 += (x1 * mLon) * (y2 * mLat) - (x2 * mLon) * (y1 * mLat);
      }
      const areaM2 = Math.abs(area2) / 2;
      const osmLine = entry.osmId != null ? `  osm_id: ${entry.osmId}` : `  osm_id: (custom or synthetic)`;
      logPrompt('info', `Building ${entry.letter}`);
      logPrompt('info', `  syn_id: ${entry.key}`);
      logPrompt('info', osmLine);
      logPrompt('info', `  center: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
      logPrompt('info', `  height: ${entry.height} m  (base ${entry.base} m)`);
      logPrompt('info', `  area:   ${Math.round(areaM2)} m²`);
      logPrompt('info', `  hidden: ${hiddenBuildingKeys.has(entry.key) ? 'yes' : 'no'}`);
      logPrompt('info', `  highlighted: ${highlightedBuildings.has(entry.key) ? 'yes' : 'no'}`);
  }

  const weather = createWeatherController({
      map,
      state,
      dbg,
      elements: {
          icon: document.getElementById('weather-icon'),
          temperature: document.getElementById('weather-temp'),
          description: document.getElementById('weather-desc'),
          extra: document.getElementById('weather-extra'),
          overlay: document.getElementById('visibility-overlay')
      }
  });
  weather.bind();

  const overlayHelpers = createMapOverlayHelpers({
      map,
      dbg,
      tileBounds,
      lngLatToTile,
      center: CENTER,
      fadeOuterMeters: FADE_OUTER_METERS,
      logPrompt
  });

  function addSmoothFade() {
      overlayHelpers.addSmoothFade();
  }

  function addBlackVoid() {
      overlayHelpers.addBlackVoid();
  }

  function rebuildHiddenTileCovers() {
      overlayHelpers.rebuildHiddenTileCovers(hiddenTiles);
  }

  function ensureTileHoverLayer() {
      overlayHelpers.ensureTileHoverLayer();
  }

  function updateTileHover(lon, lat) {
      overlayHelpers.updateTileHover({ lon, lat, tilePickerActive, hiddenTiles });
  }

  function clearTileHover() {
      overlayHelpers.clearTileHover();
  }

  function toggleTileAt(lon, lat) {
      const nextTiles = overlayHelpers.toggleTileAt({ lon, lat, hiddenTiles });
      Object.assign(hiddenTiles, nextTiles);
      rebuildHiddenTileCovers();
      updateTileHover(lon, lat);
  }

  function setTilePickerActive(active) {
      if (active) {
          if (roadDrawActive) cancelRoad();
          if (roadDeleteActive) setRoadDeleteActive(false);
          if (buildingDrawActive) cancelBuilding();
          if (buildingEditActive) stopBuildingEdit();
          if (buildingDeleteActive) setBuildingDeleteActive(false);
          if (zoneDrawActive) cancelZone();
          if (zoneDeleteActive) setZoneDeleteActive(false);
      }
      tilePickerActive = active;
      const btn = document.getElementById('tile-picker-btn');
      if (btn) btn.classList.toggle('active', active);
      map.getCanvas().style.cursor = active ? 'crosshair' : '';
      if (!active) clearTileHover();
      logPrompt('info', active ? 'Tile picker ON.' : 'Tile picker OFF.');
  }

  const roadLayerController = createRoadLayerController({ map, dbg });

  const ROAD_LAYER_IDS = roadLayerController.ROAD_LAYER_IDS;

  function createRoadLayers() {
      roadLayerController.createRoadLayers({
          drawnRoads,
          roadDrawActive,
          roadDrawWidth,
          roadDrawColor,
          draftCoords,
          draftCursor,
          roadDeleteActive,
          refreshDrawnRoads,
          setDraftData,
          updateRoadDrawButton,
          updateRoadDeleteButton
      });
  }

  function roadLayersArePositioned() {
      return roadLayerController.roadLayersArePositioned();
  }

  function positionRoadLayers() {
      roadLayerController.positionRoadLayers();
  }

  let roadPosScheduled = false;
  function schedulePositionRoadLayers() {
      roadLayerController.schedulePositionRoadLayers();
  }

  function updateRoadDrawButton() {
      roadLayerController.updateRoadDrawButton({ roadDrawActive, draftCoords, drawnRoads });
  }
  function updateRoadDeleteButton() {
      roadLayerController.updateRoadDeleteButton({ roadDeleteActive, drawnRoads });
  }

  function refreshDrawnRoads() {
      const src = map.getSource('drawn-roads-src');
      if (src) {
          src.setData({
              type: 'FeatureCollection',
              features: [...drawnRoads.values()].map(r => ({
                  type: 'Feature',
                  properties: { id: r.id, color: r.color, width: r.width },
                  geometry: { type: 'LineString', coordinates: r.coords }
              }))
          });
      }
      updateRoadDrawButton();
      updateRoadDeleteButton();
      if (hoveredDeleteRoadId && !drawnRoads.has(hoveredDeleteRoadId)) clearDeleteHover();
  }

  function setDraftData() {
      const lineSrc = map.getSource('road-draft-src');
      if (lineSrc) {
          const coords = draftCoords.slice();
          if (roadDrawActive && draftCursor && coords.length) coords.push(draftCursor);
          lineSrc.setData({
              type: 'FeatureCollection',
              features: coords.length >= 2 ? [{
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'LineString', coordinates: coords }
              }] : []
          });
      }
      const ptSrc = map.getSource('road-draft-points-src');
      if (ptSrc) {
          ptSrc.setData({
              type: 'FeatureCollection',
              features: draftCoords.map(c => ({
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'Point', coordinates: c }
              }))
          });
      }
      updateRoadDrawButton();
  }

  function setDeleteHover(road) {
      if (!road) { clearDeleteHover(); return; }
      hoveredDeleteRoadId = road.id;
      const src = map.getSource('road-delete-hover-src');
      if (src) {
          src.setData({
              type: 'FeatureCollection',
              features: [{
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'LineString', coordinates: road.coords }
              }]
          });
      }
  }
  function clearDeleteHover() {
      hoveredDeleteRoadId = null;
      const src = map.getSource('road-delete-hover-src');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function setRoadDrawActive(active) {
      if (active) {
          if (tilePickerActive) setTilePickerActive(false);
          if (roadDeleteActive) setRoadDeleteActive(false);
          if (buildingDrawActive) cancelBuilding();
          if (buildingEditActive) stopBuildingEdit();
          if (buildingDeleteActive) setBuildingDeleteActive(false);
          if (zoneDrawActive) cancelZone();
          if (zoneDeleteActive) setZoneDeleteActive(false);
      }
      roadDrawActive = active;
      if (active) {
          if (!map.getLayer('drawn-roads')) createRoadLayers();
          else positionRoadLayers();
          map.doubleClickZoom.disable();
          map.getCanvas().style.cursor = 'crosshair';
      } else {
          map.doubleClickZoom.enable();
          if (!roadDeleteActive) map.getCanvas().style.cursor = '';
          draftCursor = null;
      }
      updateRoadDrawButton();
      setDraftData();
  }

  function setRoadDeleteActive(active) {
      if (active) {
          if (tilePickerActive) setTilePickerActive(false);
          if (roadDrawActive) cancelRoad();
          if (buildingDrawActive) cancelBuilding();
          if (buildingEditActive) stopBuildingEdit();
          if (buildingDeleteActive) setBuildingDeleteActive(false);
          if (zoneDrawActive) cancelZone();
          if (zoneDeleteActive) setZoneDeleteActive(false);
      }
      roadDeleteActive = active;
      if (active) {
          if (!map.getLayer('drawn-roads')) createRoadLayers();
          else positionRoadLayers();
          map.getCanvas().style.cursor = 'crosshair';
          if (!drawnRoads.size) logPrompt('info', 'No drawn roads to delete yet.');
      } else {
          clearDeleteHover();
          map.getCanvas().style.cursor = '';
      }
      updateRoadDeleteButton();
  }

  function startRoadDrawing() {
      if (roadDrawActive) return logPrompt('info', 'Already drawing.');
      draftCoords = [];
      draftCursor = null;
      setRoadDrawActive(true);
      logPrompt('bot', `Road drawing ON — color #ff0000, width ${roadDrawWidth} m.`);
  }
  function startRoadDeleting() {
      if (roadDeleteActive) { setRoadDeleteActive(false); return logPrompt('info', 'Road deletion OFF.'); }
      setRoadDeleteActive(true);
      logPrompt('bot', 'Road deletion ON — hover a road and click to delete it.');
  }

  function finishRoad() {
      if (!roadDrawActive) return logPrompt('info', 'Not drawing.');
      if (draftCoords.length < 2) {
          logPrompt('error', 'A road needs at least 2 points — cancelled.');
          return cancelRoad();
      }
      const id = `road-${++roadIdCounter}`;
      const n = draftCoords.length;
      drawnRoads.set(id, { id, coords: draftCoords.slice(), color: '#ff0000', width: roadDrawWidth });
      draftCoords = [];
      draftCursor = null;
      setRoadDrawActive(false);
      refreshDrawnRoads();
      setDraftData();
      positionRoadLayers();
      logPrompt('bot', `Added ${id} (${n} points).`);
  }
  function cancelRoad() {
      if (!roadDrawActive && !draftCoords.length) return logPrompt('info', 'Not drawing.');
      draftCoords = [];
      draftCursor = null;
      setRoadDrawActive(false);
      setDraftData();
      logPrompt('bot', 'Road drawing cancelled.');
  }
  function addDraftPoint(lon, lat) {
      draftCoords.push([lon, lat]);
      draftCursor = [lon, lat];
      setDraftData();
  }
  function undoDraftPoint() {
      if (!roadDrawActive) return logPrompt('info', 'Not drawing.');
      if (!draftCoords.length) return logPrompt('info', 'No points to undo.');
      draftCoords.pop();
      setDraftData();
      logPrompt('info', `Point removed — ${draftCoords.length} left.`);
  }
  function clearAllRoads() {
      if (!drawnRoads.size) return logPrompt('info', 'No drawn roads.');
      const n = drawnRoads.size;
      drawnRoads.clear();
      clearDeleteHover();
      refreshDrawnRoads();
      logPrompt('bot', `${n} drawn road(s) removed.`);
  }
  function listRoads() {
      if (!drawnRoads.size) return logPrompt('info', 'No drawn roads yet.');
      logPrompt('info', `Drawn roads: ${drawnRoads.size}`);
      for (const r of drawnRoads.values()) {
          const [lon, lat] = r.coords[0];
          logPrompt('info', `  ${r.id}  ${r.coords.length} pts  ${r.color}  w=${r.width}m  start ${lat.toFixed(5)},${lon.toFixed(5)}`);
      }
  }
  function deleteRoadById(id) {
      if (!drawnRoads.has(id)) return false;
      drawnRoads.delete(id);
      if (hoveredDeleteRoadId === id) clearDeleteHover();
      refreshDrawnRoads();
      return true;
  }
  function findRoadAtPoint(point) {
      if (!map.getLayer('drawn-roads')) return null;
      let hits;
      try { hits = map.queryRenderedFeatures(point, { layers: ['drawn-roads'] }); }
      catch (e) { return null; }
      if (!hits || !hits.length) return null;
      for (const h of hits) {
          const id = h.properties && h.properties.id;
          if (id && drawnRoads.has(id)) return drawnRoads.get(id);
      }
      return null;
  }
  function setRoadColor(name) {
      const c = resolveColor(name);
      if (!c) return logPrompt('error', `Unknown color: "${name}"`);
      roadDrawColor = c;
      logPrompt('bot', `Draft colour set to ${c}.`);
  }
  function setRoadWidth(n) {
      const v = Math.max(0.5, Math.min(60, n));
      roadDrawWidth = v;
      logPrompt('bot', `Road width set to ${v} m.`);
  }

  const BUILDING_OVERLAY_LAYER_IDS = [
      'building-vertices','building-selected','building-draft-points',
      'building-draft-line','building-draft-fill',
      'building-delete-hover-outline','building-delete-hover-fill'
  ];

  function createBuildingEditorLayers() {
      if (!map.getSource('building-draft-fill-src')) map.addSource('building-draft-fill-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource('building-draft-line-src')) map.addSource('building-draft-line-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource('building-draft-points-src')) map.addSource('building-draft-points-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource('building-selected-src')) map.addSource('building-selected-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource('building-vertices-src')) map.addSource('building-vertices-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getLayer('building-draft-fill')) map.addLayer({ id: 'building-draft-fill', type: 'fill', source: 'building-draft-fill-src', paint: { 'fill-color': buildingDefaultColor, 'fill-opacity': 0.28 } });
      if (!map.getLayer('building-draft-line')) map.addLayer({ id: 'building-draft-line', type: 'line', source: 'building-draft-line-src', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7c3aed', 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': 1 } });
      if (!map.getLayer('building-draft-points')) map.addLayer({ id: 'building-draft-points', type: 'circle', source: 'building-draft-points-src', paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 2 } });
      if (!map.getLayer('building-selected')) map.addLayer({ id: 'building-selected', type: 'line', source: 'building-selected-src', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0ea5e9', 'line-width': 3, 'line-opacity': 1 } });
      if (!map.getLayer('building-vertices')) map.addLayer({ id: 'building-vertices', type: 'circle', source: 'building-vertices-src', paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#0284c7', 'circle-stroke-width': 2.5 } });
      bringBuildingEditorToTop();
  }

  function createBuildingDeleteLayers() {
      if (!map.getSource('building-delete-hover-src')) map.addSource('building-delete-hover-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getLayer('building-delete-hover-fill')) map.addLayer({ id: 'building-delete-hover-fill', type: 'fill', source: 'building-delete-hover-src', paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.45 } });
      if (!map.getLayer('building-delete-hover-outline')) map.addLayer({ id: 'building-delete-hover-outline', type: 'line', source: 'building-delete-hover-src', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ef4444', 'line-width': 3, 'line-opacity': 1 } });
      bringBuildingEditorToTop();
  }

  function bringBuildingEditorToTop() {
      for (let i = BUILDING_OVERLAY_LAYER_IDS.length - 1; i >= 0; i--) {
          const id = BUILDING_OVERLAY_LAYER_IDS[i];
          if (map.getLayer(id)) map.moveLayer(id);
      }
  }

  let buildingOverlaysPosScheduled = false;
  function scheduleBringBuildingEditorToTop() {
      if (buildingOverlaysPosScheduled) return;
      buildingOverlaysPosScheduled = true;
      requestAnimationFrame(() => { buildingOverlaysPosScheduled = false; bringBuildingEditorToTop(); });
  }

  function setBuildingDraftData() {
      const fillSrc = map.getSource('building-draft-fill-src');
      if (fillSrc) {
          const closed = buildingDraftCoords.length >= 3 ? [[...buildingDraftCoords, buildingDraftCoords[0]]] : [];
          fillSrc.setData({
              type: 'FeatureCollection',
              features: closed.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: closed } }] : []
          });
      }
      const lineSrc = map.getSource('building-draft-line-src');
      if (lineSrc) {
          const coords = buildingDraftCoords.slice();
          if (buildingDrawActive && !pendingBuilding && buildingDraftCursor && coords.length) coords.push(buildingDraftCursor);
          if (buildingDrawActive && coords.length >= 3) coords.push(coords[0]);
          lineSrc.setData({
              type: 'FeatureCollection',
              features: coords.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : []
          });
      }
      const ptSrc = map.getSource('building-draft-points-src');
      if (ptSrc) {
          ptSrc.setData({
              type: 'FeatureCollection',
              features: buildingDraftCoords.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
          });
      }
      updateBuildingBuildButton();
  }

  function updateSelectionOverlay() {
      const selected = selectedBuildingId ? customBuildings.get(selectedBuildingId) : null;
      const selSrc = map.getSource('building-selected-src');
      if (selSrc) {
          selSrc.setData({
              type: 'FeatureCollection',
              features: selected ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...selected.coords, selected.coords[0]] } }] : []
          });
      }
      const vSrc = map.getSource('building-vertices-src');
      if (vSrc) {
          vSrc.setData({
              type: 'FeatureCollection',
              features: selected ? selected.coords.map((c, i) => ({ type: 'Feature', properties: { index: i }, geometry: { type: 'Point', coordinates: c } })) : []
          });
      }
  }

  function findBuildingAtPoint(point) {
      if (!map.getLayer('buildings-live')) return null;
      let hits;
      try { hits = map.queryRenderedFeatures(point, { layers: ['buildings-live'] }); }
      catch (e) { return null; }
      if (!hits || !hits.length) return null;
      let customHit = null;
      for (const h of hits) {
          const props = h.properties || {};
          if (props.custom_id && customBuildings.has(props.custom_id)) { customHit = h; break; }
      }
      const h = customHit || hits[0];
      const props = h.properties || {};
      if (props.custom_id && customBuildings.has(props.custom_id)) {
          return { kind: 'custom', id: props.custom_id, geometry: h.geometry };
      }
      const key = buildingKey(h);
      if (key && !hiddenBuildingKeys.has(key)) return { kind: 'osm', key, geometry: h.geometry };
      return null;
  }

  function setBuildingDeleteHover(entry) {
      if (!entry) { clearBuildingDeleteHover(); return; }
      hoveredDeleteBuilding = entry;
      const src = map.getSource('building-delete-hover-src');
      if (!src) return;
      src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: entry.geometry }] });
  }
  function clearBuildingDeleteHover() {
      hoveredDeleteBuilding = null;
      const src = map.getSource('building-delete-hover-src');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function saveCustomBuildings() {
      try { localStorage.setItem(CUSTOM_BUILDINGS_STORAGE_KEY, JSON.stringify([...customBuildings.values()])); }
      catch (e) { dbg('save failed: ' + e.message); }
  }
  function loadCustomBuildings() {
      try {
          const raw = localStorage.getItem(CUSTOM_BUILDINGS_STORAGE_KEY);
          if (!raw) return 0;
          const arr = JSON.parse(raw);
          if (!Array.isArray(arr)) return 0;
          customBuildings.clear();
          for (const b of arr) {
              if (!b || !Array.isArray(b.coords) || b.coords.length < 3) continue;
              const id = String(b.id || `custom-${++buildingIdCounter}`);
              customBuildings.set(id, {
                  id,
                  coords: b.coords.map(c => [Number(c[0]), Number(c[1])]),
                  height: Number.isFinite(b.height) ? b.height : buildingDefaultHeight,
                  base: Number.isFinite(b.base) ? b.base : 0,
                  color: typeof b.color === 'string' ? b.color : buildingDefaultColor
              });
              const num = parseInt(id.replace(/^custom-/, ''), 10);
              if (Number.isFinite(num) && num > buildingIdCounter) buildingIdCounter = num;
          }
          return customBuildings.size;
      } catch (e) { dbg('load failed: ' + e.message); return 0; }
  }

  function showHeightPanel(defaultHeight) {
      const panel = document.getElementById('height-panel');
      const input = document.getElementById('height-input');
      if (!panel || !input) return;
      input.value = String(defaultHeight);
      panel.classList.remove('hidden');
      map.dragPan.disable();
      map.scrollZoom.disable();
      map.dragRotate.disable();
      map.boxZoom.disable();
      setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  function hideHeightPanel() {
      const panel = document.getElementById('height-panel');
      if (panel) panel.classList.add('hidden');
      const input = document.getElementById('height-input');
      if (input) input.blur();
      map.dragPan.enable();
      map.scrollZoom.enable();
      map.dragRotate.enable();
      map.boxZoom.enable();
  }
  function focusHeightInput() {
      const input = document.getElementById('height-input');
      if (input) { input.focus(); input.select(); }
  }
  function readHeightInput() {
      const input = document.getElementById('height-input');
      if (!input) return buildingDefaultHeight;
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v <= 0) return buildingDefaultHeight;
      return Math.min(500, Math.max(1, v));
  }

  function commitPendingBuilding(height) {
      if (!pendingBuilding) return;
      const n = pendingBuilding.coords.length;
      const id = `custom-${++buildingIdCounter}`;
      customBuildings.set(id, {
          id, coords: pendingBuilding.coords, height, base: 0, color: buildingDefaultColor
      });
      pendingBuilding = null;
      buildingDraftCoords = [];
      buildingDraftCursor = null;
      hideHeightPanel();
      setBuildingDrawActive(false);
      refreshBuildings();
      if (state.buildingLabels) updateBuildingLabels();
      saveCustomBuildings();
      buildingDefaultHeight = height;
      logPrompt('bot', `Added building ${id} (${n} vertices, ${height} m).`);
      selectedBuildingId = id;
      updateSelectionOverlay();
      updateBuildingEditButton();
  }
  function cancelPendingBuilding() {
      if (!pendingBuilding) return;
      pendingBuilding = null;
      buildingDraftCoords = [];
      buildingDraftCursor = null;
      hideHeightPanel();
      setBuildingDrawActive(false);
      logPrompt('bot', 'Building creation cancelled.');
  }

  function updateBuildingBuildButton() {
      const btn = document.getElementById('building-build-btn');
      if (!btn) return;
      if (pendingBuilding) {
          btn.textContent = `⏳ Awaiting height…`;
          btn.classList.add('active');
          return;
      }
      if (buildingDrawActive) btn.textContent = `✅ Finish building (${buildingDraftCoords.length})`;
      else btn.textContent = customBuildings.size ? `🏗️ Build building (${customBuildings.size})` : '🏗️ Build building';
      btn.classList.toggle('active', buildingDrawActive);
  }
  function updateBuildingDeleteButton() {
      const btn = document.getElementById('building-delete-btn');
      if (!btn) return;
      if (buildingDeleteActive) btn.textContent = `🗑️ Stop deleting`;
      else btn.textContent = '🗑️ Delete building';
      btn.classList.toggle('active', buildingDeleteActive);
  }
  function updateBuildingEditButton() {
      const btn = document.getElementById('building-edit-btn');
      if (!btn) return;
      if (buildingEditActive) btn.textContent = selectedBuildingId ? `✏️ Editing (1 selected)` : `✏️ Editing`;
      else btn.textContent = '✏️ Edit buildings';
      btn.classList.toggle('active', buildingEditActive);
  }

  function setBuildingDrawActive(active) {
      if (active) {
          if (tilePickerActive) setTilePickerActive(false);
          if (roadDrawActive) cancelRoad();
          if (roadDeleteActive) setRoadDeleteActive(false);
          if (buildingEditActive) stopBuildingEdit();
          if (buildingDeleteActive) setBuildingDeleteActive(false);
          if (zoneDrawActive) cancelZone();
          if (zoneDeleteActive) setZoneDeleteActive(false);
      }
      buildingDrawActive = active;
      if (active) {
          createBuildingEditorLayers();
          map.doubleClickZoom.disable();
          map.getCanvas().style.cursor = 'crosshair';
      } else {
          map.doubleClickZoom.enable();
          map.getCanvas().style.cursor = '';
          buildingDraftCursor = null;
      }
      updateBuildingBuildButton();
      setBuildingDraftData();
  }

  function setBuildingDeleteActive(active) {
      if (active) {
          if (tilePickerActive) setTilePickerActive(false);
          if (roadDrawActive) cancelRoad();
          if (roadDeleteActive) setRoadDeleteActive(false);
          if (buildingDrawActive) cancelBuilding();
          if (buildingEditActive) stopBuildingEdit();
          if (zoneDrawActive) cancelZone();
          if (zoneDeleteActive) setZoneDeleteActive(false);
      }
      buildingDeleteActive = active;
      if (active) {
          createBuildingDeleteLayers();
          map.getCanvas().style.cursor = 'crosshair';
          if (!customBuildings.size) logPrompt('info', 'No custom buildings yet — OSM buildings can still be hidden by clicking.');
      } else {
          clearBuildingDeleteHover();
          map.getCanvas().style.cursor = '';
      }
      updateBuildingDeleteButton();
  }

  function startBuildingDrawing() {
      if (pendingBuilding) { focusHeightInput(); return; }
      if (buildingDrawActive) return logPrompt('info', 'Already drawing.');
      buildingDraftCoords = [];
      buildingDraftCursor = null;
      setBuildingDrawActive(true);
      logPrompt('bot', `Building drawing ON — default ${buildingDefaultHeight} m.`);
      logPrompt('info', 'Click map to add vertices · Enter/first-vertex to finish · Esc cancel.');
  }
  function startBuildingDeleting() {
      if (buildingDeleteActive) { setBuildingDeleteActive(false); return logPrompt('info', 'Building deletion OFF.'); }
      setBuildingDeleteActive(true);
      logPrompt('bot', 'Building deletion ON.');
  }
  function addBuildingVertex(lon, lat) {
      if (buildingDraftCoords.length) {
          const [lastLon, lastLat] = buildingDraftCoords[buildingDraftCoords.length - 1];
          const d = Math.hypot(lon - lastLon, lat - lastLat);
          if (d < 1e-6) return;
      }
      buildingDraftCoords.push([lon, lat]);
      buildingDraftCursor = [lon, lat];
      setBuildingDraftData();
  }
  function undoBuildingVertex() {
      if (!buildingDrawActive) return logPrompt('info', 'Not building.');
      if (!buildingDraftCoords.length) return logPrompt('info', 'No vertices to undo.');
      buildingDraftCoords.pop();
      setBuildingDraftData();
      logPrompt('info', `Vertex removed — ${buildingDraftCoords.length} left.`);
  }
  function finishBuilding() {
      if (!buildingDrawActive) return logPrompt('info', 'Not building.');
      if (pendingBuilding) { focusHeightInput(); return; }
      if (buildingDraftCoords.length < 3) {
          logPrompt('error', 'A building needs at least 3 vertices — cancelled.');
          return cancelBuilding();
      }
      pendingBuilding = { coords: buildingDraftCoords.slice() };
      buildingDraftCursor = null;
      showHeightPanel(buildingDefaultHeight);
      setBuildingDraftData();
  }
  function cancelBuilding() {
      if (pendingBuilding) return cancelPendingBuilding();
      if (!buildingDrawActive && !buildingDraftCoords.length) return logPrompt('info', 'Not building.');
      buildingDraftCoords = [];
      buildingDraftCursor = null;
      setBuildingDrawActive(false);
      setBuildingDraftData();
      logPrompt('bot', 'Building drawing cancelled.');
  }
  function startBuildingEdit() {
      if (buildingEditActive) return logPrompt('info', 'Already editing.');
      if (pendingBuilding) cancelPendingBuilding();
      if (tilePickerActive) setTilePickerActive(false);
      if (roadDrawActive) cancelRoad();
      if (roadDeleteActive) setRoadDeleteActive(false);
      if (buildingDrawActive) cancelBuilding();
      if (buildingDeleteActive) setBuildingDeleteActive(false);
      if (zoneDrawActive) cancelZone();
      if (zoneDeleteActive) setZoneDeleteActive(false);
      buildingEditActive = true;
      createBuildingEditorLayers();
      updateBuildingEditButton();
      logPrompt('bot', 'Building edit ON.');
  }
  function stopBuildingEdit() {
      if (!buildingEditActive) return logPrompt('info', 'Not editing.');
      buildingEditActive = false;
      selectedBuildingId = null;
      buildingDragState = null;
      updateSelectionOverlay();
      updateBuildingEditButton();
      map.getCanvas().style.cursor = '';
      saveCustomBuildings();
      logPrompt('bot', 'Building edit OFF.');
  }
  function selectBuilding(id) {
      selectedBuildingId = id;
      updateSelectionOverlay();
      updateBuildingEditButton();
      const b = customBuildings.get(id);
      if (b) logPrompt('info', `Selected ${id} (${b.height} m, ${b.color}).`);
  }
  function deselectBuilding() {
      selectedBuildingId = null;
      updateSelectionOverlay();
      updateBuildingEditButton();
  }
  function deleteSelectedBuilding() {
      if (!selectedBuildingId) return logPrompt('info', 'No building selected.');
      const id = selectedBuildingId;
      if (!customBuildings.has(id)) return logPrompt('error', 'Selected building no longer exists.');
      customBuildings.delete(id);
      selectedBuildingId = null;
      updateSelectionOverlay();
      refreshBuildings();
      if (state.buildingLabels) updateBuildingLabels();
      saveCustomBuildings();
      logPrompt('bot', `Deleted ${id}.`);
  }
  function clearAllCustomBuildings() {
      if (!customBuildings.size) return logPrompt('info', 'No custom buildings.');
      const n = customBuildings.size;
      customBuildings.clear();
      selectedBuildingId = null;
      updateSelectionOverlay();
      refreshBuildings();
      if (state.buildingLabels) updateBuildingLabels();
      saveCustomBuildings();
      logPrompt('bot', `${n} custom building(s) removed.`);
  }
  function listCustomBuildings() {
      if (!customBuildings.size) return logPrompt('info', 'No custom buildings yet.');
      logPrompt('info', `Custom buildings: ${customBuildings.size}`);
      for (const b of customBuildings.values()) {
          const [lon, lat] = centerOfCoordinates(b.coords);
          logPrompt('info', `  ${b.id}  ${b.coords.length} vtx  h=${b.height}m  ${b.color}  @ ${lat.toFixed(5)},${lon.toFixed(5)}`);
      }
  }
  function setBuildingHeight(n) {
      const v = Math.max(1, Math.min(500, n));
      if (pendingBuilding) {
          const input = document.getElementById('height-input');
          if (input) input.value = String(v);
          return logPrompt('bot', `Height prompt updated to ${v} m.`);
      }
      if (selectedBuildingId && customBuildings.has(selectedBuildingId)) {
          customBuildings.get(selectedBuildingId).height = v;
          refreshBuildings();
          saveCustomBuildings();
          logPrompt('bot', `Height of ${selectedBuildingId} set to ${v} m.`);
      } else {
          buildingDefaultHeight = v;
          logPrompt('bot', `Default height for new buildings set to ${v} m.`);
      }
  }
  function setBuildingColor(name) {
      const c = resolveColor(name);
      if (!c) return logPrompt('error', `Unknown color: "${name}"`);
      if (selectedBuildingId && customBuildings.has(selectedBuildingId)) {
          customBuildings.get(selectedBuildingId).color = c;
          refreshBuildings();
          saveCustomBuildings();
          logPrompt('bot', `Color of ${selectedBuildingId} set to ${c}.`);
      } else {
          buildingDefaultColor = c;
          if (map.getLayer('building-draft-fill')) map.setPaintProperty('building-draft-fill', 'fill-color', c);
          logPrompt('bot', `Default color for new buildings set to ${c}.`);
      }
  }
  function tryStartBuildingDrag(e) {
      if (!buildingEditActive || !selectedBuildingId) return false;
      const selected = customBuildings.get(selectedBuildingId);
      if (!selected) return false;
      if (map.getLayer('building-vertices')) {
          let vHits = [];
          try { vHits = map.queryRenderedFeatures(e.point, { layers: ['building-vertices'] }); }
          catch (_) { vHits = []; }
          if (vHits.length) {
              const idx = vHits[0].properties.index;
              if (Number.isInteger(idx) && idx >= 0 && idx < selected.coords.length) {
                  buildingDragState = {
                      type: 'vertex', id: selectedBuildingId, index: idx,
                      startCoords: selected.coords.map(c => [...c])
                  };
                  map.dragPan.disable();
                  map.getCanvas().style.cursor = 'grabbing';
                  return true;
              }
          }
      }
      if (map.getLayer('buildings-live')) {
          let bHits = [];
          try { bHits = map.queryRenderedFeatures(e.point, { layers: ['buildings-live'] }); }
          catch (_) { bHits = []; }
          const isSelected = bHits.some(h => h.properties && h.properties.custom_id === selectedBuildingId);
          if (isSelected) {
              buildingDragState = {
                  type: 'body', id: selectedBuildingId,
                  startLngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
                  startCoords: selected.coords.map(c => [...c])
              };
              map.dragPan.disable();
              map.getCanvas().style.cursor = 'grabbing';
              return true;
          }
      }
      return false;
  }
  function updateBuildingDrag(e) {
      if (!buildingDragState) return;
      const b = customBuildings.get(buildingDragState.id);
      if (!b) { buildingDragState = null; return; }
      if (buildingDragState.type === 'vertex') {
          b.coords[buildingDragState.index] = [e.lngLat.lng, e.lngLat.lat];
      } else if (buildingDragState.type === 'body') {
          const dLng = e.lngLat.lng - buildingDragState.startLngLat.lng;
          const dLat = e.lngLat.lat - buildingDragState.startLngLat.lat;
          b.coords = buildingDragState.startCoords.map(([lon, lat]) => [lon + dLng, lat + dLat]);
      }
      rebuildBuildingsSource();
      if (highlightedBuildings.size) rebuildHighlights();
      updateSelectionOverlay();
  }
  function endBuildingDrag() {
      if (!buildingDragState) return;
      buildingDragState = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      saveCustomBuildings();
      suppressNextMapClick = true;
  }

  const ZONE_TOP_LAYER_IDS = ['zone-labels','zone-draft-outline','zone-draft-fill','zone-delete-hover-outline','zone-delete-hover-fill'];

  function createZoneLayers() {
      if (!map.getSource('zones-src')) map.addSource('zones-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource('zone-labels-src')) map.addSource('zone-labels-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource('zone-draft-src')) map.addSource('zone-draft-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource('zone-delete-hover-src')) map.addSource('zone-delete-hover-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const colorExpr = ['match', ['get', 'class'], 'Flood', '#2563eb', 'Green', '#16a34a', 'Shade', '#6b7280', '#888888'];
      const before = map.getLayer('buildings-shadow') ? 'buildings-shadow' : (map.getLayer('buildings-live') ? 'buildings-live' : undefined);
      if (!map.getLayer('zones-fill')) map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones-src', paint: { 'fill-color': colorExpr, 'fill-opacity': 0.4 } }, before);
      if (!map.getLayer('zones-outline')) map.addLayer({ id: 'zones-outline', type: 'line', source: 'zones-src', paint: { 'line-color': colorExpr, 'line-opacity': 1.0, 'line-width': 3 } }, before);
      if (!map.getLayer('zone-draft-fill')) map.addLayer({ id: 'zone-draft-fill', type: 'fill', source: 'zone-draft-src', paint: { 'fill-color': ['match', ['get', 'class'], 'Flood', '#2563eb', 'Green', '#16a34a', 'Shade', '#6b7280', '#0ea5e9'], 'fill-opacity': 0.4 } });
      if (!map.getLayer('zone-draft-outline')) map.addLayer({ id: 'zone-draft-outline', type: 'line', source: 'zone-draft-src', paint: { 'line-color': ['match', ['get', 'class'], 'Flood', '#2563eb', 'Green', '#16a34a', 'Shade', '#6b7280', '#0ea5e9'], 'line-opacity': 1.0, 'line-width': 2.5, 'line-dasharray': [3, 2] } });
      if (!map.getLayer('zone-delete-hover-fill')) map.addLayer({ id: 'zone-delete-hover-fill', type: 'fill', source: 'zone-delete-hover-src', paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.5 } });
      if (!map.getLayer('zone-delete-hover-outline')) map.addLayer({ id: 'zone-delete-hover-outline', type: 'line', source: 'zone-delete-hover-src', paint: { 'line-color': '#ef4444', 'line-width': 3, 'line-opacity': 1 } });
      if (!map.getLayer('zone-labels')) {
          const fontStack = detectFontStack();
          map.addLayer({
              id: 'zone-labels', type: 'symbol', source: 'zone-labels-src',
              layout: {
                  'text-field': ['get', 'label'], 'text-font': fontStack,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 15, 12, 18, 16, 19, 20],
                  'text-allow-overlap': true, 'text-ignore-placement': true,
                  'text-rotation-alignment': 'viewport', 'text-pitch-alignment': 'viewport'
              },
              paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b1220', 'text-halo-width': 2.5, 'text-halo-blur': 0.5 }
          });
      }
      refreshZones();
      bringZoneTopLayersToTop();
  }

  function bringZoneTopLayersToTop() {
      for (let i = ZONE_TOP_LAYER_IDS.length - 1; i >= 0; i--) {
          const id = ZONE_TOP_LAYER_IDS[i];
          if (map.getLayer(id)) map.moveLayer(id);
      }
  }

  let zoneTopPosScheduled = false;
  function scheduleBringZoneTopLayersToTop() {
      if (zoneTopPosScheduled) return;
      zoneTopPosScheduled = true;
      requestAnimationFrame(() => { zoneTopPosScheduled = false; bringZoneTopLayersToTop(); });
  }

  function refreshZones() {
      const features = [];
      const labelFeatures = [];
      for (const zone of zones.values()) {
          const coords = zoneCircleCoords(zone.center, zone.radiusMeters, 64);
          features.push({ type: 'Feature', properties: { id: zone.id, class: zone.class }, geometry: { type: 'Polygon', coordinates: [coords] } });
          labelFeatures.push({ type: 'Feature', properties: { id: zone.id, label: zone.id }, geometry: { type: 'Point', coordinates: zone.center } });
      }
      const src = map.getSource('zones-src');
      if (src) src.setData({ type: 'FeatureCollection', features });
      const labelSrc = map.getSource('zone-labels-src');
      if (labelSrc) labelSrc.setData({ type: 'FeatureCollection', features: labelFeatures });
      updateZoneDrawButton();
      updateZoneDeleteButton();
      if (hoveredDeleteZoneId && !zones.has(hoveredDeleteZoneId)) clearZoneDeleteHover();
  }

  function updateZoneDraftPreview() {
      const src = map.getSource('zone-draft-src');
      if (!src) return;
      if (!zoneDrawActive || !zoneDraftCenter) {
          src.setData({ type: 'FeatureCollection', features: [] });
          return;
      }
      const radius = zoneDraftRadiusM > 0 ? zoneDraftRadiusM : 1;
      const coords = zoneCircleCoords(zoneDraftCenter, radius, 64);
      src.setData({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: { class: zoneDefaultClass }, geometry: { type: 'Polygon', coordinates: [coords] } }]
      });
  }

  function setZoneDeleteHover(zone) {
      if (!zone) { clearZoneDeleteHover(); return; }
      hoveredDeleteZoneId = zone.id;
      const src = map.getSource('zone-delete-hover-src');
      if (!src) return;
      const coords = zoneCircleCoords(zone.center, zone.radiusMeters, 64);
      src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } }] });
  }
  function clearZoneDeleteHover() {
      hoveredDeleteZoneId = null;
      const src = map.getSource('zone-delete-hover-src');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }
  function findZoneAtPoint(point) {
      if (!map.getLayer('zones-fill')) return null;
      let hits;
      try { hits = map.queryRenderedFeatures(point, { layers: ['zones-fill'] }); }
      catch (e) { return null; }
      if (!hits || !hits.length) return null;
      for (const h of hits) {
          const id = h.properties && h.properties.id;
          if (id && zones.has(id)) return zones.get(id);
      }
      return null;
  }

  function updateZoneDrawButton() {
      const btn = document.getElementById('zone-draw-btn');
      if (!btn) return;
      if (pendingZone) { btn.textContent = `⏳ Choose class…`; btn.classList.add('active'); return; }
      if (zoneDrawActive) btn.textContent = zoneDraftCenter ? `✅ Set radius` : `⭕ Click center`;
      else btn.textContent = zones.size ? `⭕ Draw zone (${zones.size})` : '⭕ Draw zone';
      btn.classList.toggle('active', zoneDrawActive);
  }
  function updateZoneDeleteButton() {
      const btn = document.getElementById('zone-delete-btn');
      if (!btn) return;
      if (zoneDeleteActive) btn.textContent = zones.size ? `🗑️ Stop deleting (${zones.size})` : '🗑️ Stop deleting';
      else btn.textContent = zones.size ? `🗑️ Delete zone (${zones.size})` : '🗑️ Delete zone';
      btn.classList.toggle('active', zoneDeleteActive);
  }

  function setZoneDrawActive(active) {
      if (active) {
          if (tilePickerActive) setTilePickerActive(false);
          if (roadDrawActive) cancelRoad();
          if (roadDeleteActive) setRoadDeleteActive(false);
          if (buildingDrawActive) cancelBuilding();
          if (buildingEditActive) stopBuildingEdit();
          if (buildingDeleteActive) setBuildingDeleteActive(false);
          if (zoneDeleteActive) setZoneDeleteActive(false);
      }
      zoneDrawActive = active;
      if (active) { createZoneLayers(); map.getCanvas().style.cursor = 'crosshair'; }
      else {
          map.getCanvas().style.cursor = '';
          zoneDraftCenter = null;
          zoneDraftRadiusM = 0;
          updateZoneDraftPreview();
      }
      updateZoneDrawButton();
  }

  function setZoneDeleteActive(active) {
      if (active) {
          if (tilePickerActive) setTilePickerActive(false);
          if (roadDrawActive) cancelRoad();
          if (roadDeleteActive) setRoadDeleteActive(false);
          if (buildingDrawActive) cancelBuilding();
          if (buildingEditActive) stopBuildingEdit();
          if (buildingDeleteActive) setBuildingDeleteActive(false);
          if (zoneDrawActive) cancelZone();
      }
      zoneDeleteActive = active;
      if (active) {
          createZoneLayers();
          map.getCanvas().style.cursor = 'crosshair';
      } else { clearZoneDeleteHover(); map.getCanvas().style.cursor = ''; }
      updateZoneDeleteButton();
  }

  function startZoneDrawing() {
      if (pendingZone) { showZoneClassPanel(); return; }
      if (zoneDrawActive) return logPrompt('info', 'Already drawing.');
      zoneDraftCenter = null;
      zoneDraftRadiusM = 0;
      setZoneDrawActive(true);
      logPrompt('bot', 'Zone drawing ON — click to place center, then radius.');
  }
  function startZoneDeleting() {
      if (zoneDeleteActive) { setZoneDeleteActive(false); return logPrompt('info', 'Zone deletion OFF.'); }
      setZoneDeleteActive(true);
      logPrompt('bot', 'Zone deletion ON.');
  }
  function cancelZone() {
      if (pendingZone) return cancelPendingZone();
      if (!zoneDrawActive && !zoneDraftCenter) return logPrompt('info', 'Not drawing a zone.');
      zoneDraftCenter = null;
      zoneDraftRadiusM = 0;
      setZoneDrawActive(false);
      updateZoneDraftPreview();
      logPrompt('bot', 'Zone drawing cancelled.');
  }
  function placeZoneCenter(lon, lat) {
      zoneDraftCenter = [lon, lat];
      zoneDraftRadiusM = 0;
      updateZoneDraftPreview();
      updateZoneDrawButton();
  }
  function placeZoneRadius(lon, lat) {
      if (!zoneDraftCenter) return;
      const r = haversineMeters(zoneDraftCenter[0], zoneDraftCenter[1], lon, lat);
      if (r < 1) return logPrompt('error', 'Radius too small.');
      zoneDraftRadiusM = r;
      updateZoneDraftPreview();
      pendingZone = { center: zoneDraftCenter.slice(), radiusMeters: r };
      showZoneClassPanel();
      updateZoneDrawButton();
  }
  function showZoneClassPanel() {
      const panel = document.getElementById('zone-class-panel');
      if (!panel) return;
      panel.querySelectorAll('.zone-class-btn').forEach(btn => {
          btn.classList.toggle('selected', btn.dataset.class === zoneDefaultClass);
      });
      panel.classList.remove('hidden');
      map.dragPan.disable();
      map.scrollZoom.disable();
      map.dragRotate.disable();
      map.boxZoom.disable();
  }
  function hideZoneClassPanel() {
      const panel = document.getElementById('zone-class-panel');
      if (panel) panel.classList.add('hidden');
      map.dragPan.enable();
      map.scrollZoom.enable();
      map.dragRotate.enable();
      map.boxZoom.enable();
  }
  function commitPendingZone(zoneClass) {
      if (!pendingZone) return;
      if (!ZONE_CLASSES[zoneClass]) return logPrompt('error', `Unknown class: "${zoneClass}".`);
      const id = `Z${++zoneIdCounter}`;
      zones.set(id, { id, center: pendingZone.center, radiusMeters: pendingZone.radiusMeters, class: zoneClass });
      pendingZone = null;
      zoneDraftCenter = null;
      zoneDraftRadiusM = 0;
      zoneDefaultClass = zoneClass;
      hideZoneClassPanel();
      setZoneDrawActive(false);
      updateZoneDraftPreview();
      refreshZones();
      saveZones();
      logPrompt('bot', `Created zone ${id} (${zoneClass}, r=${zones.get(id).radiusMeters.toFixed(1)} m).`);
  }
  function cancelPendingZone() {
      if (!pendingZone) return;
      pendingZone = null;
      zoneDraftCenter = null;
      zoneDraftRadiusM = 0;
      hideZoneClassPanel();
      setZoneDrawActive(false);
      updateZoneDraftPreview();
      logPrompt('bot', 'Zone creation cancelled.');
  }
  function deleteZoneById(id) {
      if (!zones.has(id)) return false;
      zones.delete(id);
      if (hoveredDeleteZoneId === id) clearZoneDeleteHover();
      refreshZones();
      saveZones();
      return true;
  }
  function clearAllZones() {
      if (!zones.size) return logPrompt('info', 'No zones.');
      const n = zones.size;
      zones.clear();
      clearZoneDeleteHover();
      refreshZones();
      saveZones();
      logPrompt('bot', `${n} zone(s) removed.`);
  }
  function listZones() {
      if (!zones.size) return logPrompt('info', 'No zones yet.');
      logPrompt('info', `Zones: ${zones.size}`);
      for (const z of zones.values()) {
          const [lon, lat] = z.center;
          logPrompt('info', `  ${z.id}  ${z.class}  r=${z.radiusMeters.toFixed(1)}m  @ ${lat.toFixed(5)},${lon.toFixed(5)}`);
      }
  }
  function setZoneClass(id, cls) {
      if (!ZONE_CLASSES[cls]) return logPrompt('error', `Unknown class: "${cls}".`);
      const zone = zones.get(id);
      if (!zone) return logPrompt('error', `No zone "${id}".`);
      zone.class = cls;
      refreshZones();
      saveZones();
      logPrompt('bot', `Zone ${id} class → ${cls}.`);
  }
  function infoAboutZone(id) {
      const zone = zones.get(id);
      if (!zone) return logPrompt('error', `No zone "${id}".`);
      const [lon, lat] = zone.center;
      const area = Math.PI * zone.radiusMeters * zone.radiusMeters;
      logPrompt('info', `Zone ${zone.id}`);
      logPrompt('info', `  class:  ${zone.class}`);
      logPrompt('info', `  center: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
      logPrompt('info', `  radius: ${zone.radiusMeters.toFixed(1)} m`);
      logPrompt('info', `  area:   ${Math.round(area)} m²`);
  }
  function saveZones() {
      try { localStorage.setItem(ZONE_STORAGE_KEY, JSON.stringify([...zones.values()])); }
      catch (e) { dbg('save zones failed: ' + e.message); }
  }
  function loadZones() {
      try {
          const raw = localStorage.getItem(ZONE_STORAGE_KEY);
          if (!raw) return 0;
          const arr = JSON.parse(raw);
          if (!Array.isArray(arr)) return 0;
          zones.clear();
          for (const z of arr) {
              if (!z || !Array.isArray(z.center) || z.center.length !== 2) continue;
              const id = String(z.id || `Z${++zoneIdCounter}`);
              const cls = ZONE_CLASSES[z.class] ? z.class : 'Flood';
              const radius = Number(z.radiusMeters) || 50;
              zones.set(id, { id, center: [Number(z.center[0]), Number(z.center[1])], radiusMeters: radius, class: cls });
              const num = parseInt(id.replace(/^Z/, ''), 10);
              if (Number.isFinite(num) && num > zoneIdCounter) zoneIdCounter = num;
          }
          return zones.size;
      } catch (e) { dbg('load zones failed: ' + e.message); return 0; }
  }

  const promptInput = document.getElementById('prompt-input');
  const promptSend  = document.getElementById('prompt-send');
  const promptLog   = document.getElementById('prompt-log');

  const COLOR_NAMES = {
      red:'#d32f2f', crimson:'#c62828', blue:'#1e6fbf', lightblue:'#8fc0e8',
      skyblue:'#4a9fe0', sky:'#4a9fe0', navy:'#1a1f2e', darkblue:'#0d2c4a',
      black:'#000000', white:'#ffffff', gray:'#808080', grey:'#808080',
      green:'#4caf50', forest:'#2e7d32', yellow:'#ffeb3b', orange:'#ff9800',
      purple:'#9c27b0', pink:'#e91e63', brown:'#5d4037', gold:'#d4af37',
      silver:'#c0c0c0', teal:'#009688', cyan:'#00bcd4', magenta:'#e91e63'
  };
  function resolveColor(s) {
      if (!s) return null;
      s = String(s).trim().toLowerCase();
      if (s.startsWith('#') && /^#[0-9a-f]{3,8}$/i.test(s)) return s;
      if (COLOR_NAMES[s]) return COLOR_NAMES[s];
      const compact = s.replace(/\s+/g, '');
      if (COLOR_NAMES[compact]) return COLOR_NAMES[compact];
      return null;
  }

  function logPrompt(role, msg) {
      const line = document.createElement('div');
      line.className = 'prompt-log-line ' + role;
      line.textContent = msg;
      promptLog.appendChild(line);
      while (promptLog.children.length > 30) promptLog.removeChild(promptLog.firstChild);
      promptLog.scrollTop = promptLog.scrollHeight;
      promptLog.classList.add('visible');
  }

  function printHelp() {
      logPrompt('info', 'Commands:');
      logPrompt('info', '• label buildings / unlabel buildings');
      logPrompt('info', '• highlight <L> [color] / unhighlight <L> / clear highlights');
      logPrompt('info', '• focus <L> · info <L>');
      logPrompt('info', '• hide <L> / show <L> / unhide [<L>|all]');
      logPrompt('info', '• list hidden / clear hidden');
      logPrompt('info', '• hide buildings / show buildings');
      logPrompt('info', '• build building <h>m <lat>,<lon> <lat>,<lon> <lat>,<lon> …');
      logPrompt('info', '• draw building · finish building · cancel building · undo');
      logPrompt('info', '• demolish / stop demolishing');
      logPrompt('info', '• edit buildings / stop editing / select building');
      logPrompt('info', '• delete building / list buildings / clear buildings');
      logPrompt('info', '• building height <m> / building color <c>');
      logPrompt('info', '• save buildings / load buildings');
      logPrompt('info', '• draw road / finish road / cancel road / undo point');
      logPrompt('info', '• delete road / stop deleting / list roads / clear roads');
      logPrompt('info', '• road color <c> / road width <m>');
      logPrompt('info', '• zone <lat>,<lon> <radius>m <Flood|Green|Shade>');
      logPrompt('info', '• draw zone / cancel zone / delete zone / list zones / clear all zones');
      logPrompt('info', '• zone class <Z#> <Flood|Green|Shade> / info zone <Z#> / delete zone <Z#>');
      logPrompt('info', '• traffic <0-200> / traffic on / traffic off / clear traffic');
      logPrompt('info', '• shadows on / shadows off / shadows <0-1> / shadows offset <px>');
      logPrompt('info', '• pick tiles / stop picking / hide tile / show all tiles');
      logPrompt('info', '• haze <0-100>% / auto / off');
      logPrompt('info', '• roads <color> / roads <0-100>% / road border <color>');
      logPrompt('info', '• zoom <n> / pitch <n> / bearing <n> / go to <lat>, <lon>');
      logPrompt('info', '• reset · help');
  }

  function doReset() {
      Object.assign(state, {
          roadFill: DEFAULTS.roadFill, roadOpacity: DEFAULTS.roadOpacity,
          casingColor: DEFAULTS.casingColor, casingOpacity: DEFAULTS.casingOpacity,
          hazeMode: DEFAULTS.hazeMode, hazeForce: DEFAULTS.hazeForce,
          buildings: DEFAULTS.buildings, labels: DEFAULTS.labels,
          buildingLabels: DEFAULTS.buildingLabels,
          ambientOcclusion: DEFAULTS.ambientOcclusion,
          aoIntensity: DEFAULTS.aoIntensity,
          aoOffset: DEFAULTS.aoOffset
      });
      clearHighlights();
      hiddenBuildingKeys.clear();
      resetLetters();
      hiddenTiles.clear();
      rebuildHiddenTileCovers();
      setTilePickerActive(false);

      draftCoords = [];
      draftCursor = null;
      setRoadDrawActive(false);
      setRoadDeleteActive(false);
      drawnRoads.clear();
      clearDeleteHover();
      refreshDrawnRoads();
      setDraftData();
      roadDrawColor = '#ff0000';
      roadDrawWidth = 6;

      if (pendingBuilding) cancelPendingBuilding();
      if (buildingDrawActive) cancelBuilding();
      if (buildingEditActive) stopBuildingEdit();
      if (buildingDeleteActive) setBuildingDeleteActive(false);
      clearBuildingDeleteHover();
      buildingDefaultHeight = 20;
      buildingDefaultColor = '#7ef29d';
      if (map.getLayer('building-draft-fill')) map.setPaintProperty('building-draft-fill', 'fill-color', buildingDefaultColor);

      if (pendingZone) cancelPendingZone();
      if (zoneDrawActive) cancelZone();
      if (zoneDeleteActive) setZoneDeleteActive(false);
      clearZoneDeleteHover();

      // Traffic reset
      setTrafficCount(0);

      refreshBuildings();
      applyRoads(); applyBuildings(); applyLabels();
      applyAmbientOcclusion();
      overlayEl.style.opacity = state.hazeForce;
      map.easeTo({ center: CENTER, zoom: 18, pitch: 60, bearing: 0, duration: 800 });
      setTimeout(() => { refreshBuildings(); if (state.buildingLabels) updateBuildingLabels(); }, 1200);
      logPrompt('bot', 'Reset to defaults.');
  }

  const LETTER = '([A-Za-z]+)';

  const COMMANDS = [
      { re: /^(help|\?)$/i, run: () => printHelp() },
      { re: /^reset$/i, run: () => doReset() },

      { re: /^(?:label|letter|number)\s+buildings?$/i,
        run: () => { state.buildingLabels = true; updateBuildingLabels(); logPrompt('bot', 'Labeling visible buildings.'); }},
      { re: /^(?:unlabel|clear\s+labels?|remove\s+building\s+labels?)\s*(?:buildings?)?$/i,
        run: () => {
            state.buildingLabels = false;
            if (map.getLayer('building-labels')) map.removeLayer('building-labels');
            if (map.getSource('building-labels-src')) map.removeSource('building-labels-src');
            labeledBuildings.clear();
            logPrompt('bot', 'Building labels removed.');
        }},

      { re: new RegExp(`^(?:highlight|select|pick|mark)\\s+${LETTER}(?:\\s+(.+))?$`, 'i'),
        run: m => {
            const c = m[2] ? resolveColor(m[2]) : null;
            if (m[2] && !c) return logPrompt('error', `Unknown color: "${m[2]}"`);
            highlightBuilding(m[1], c);
        } },
      { re: new RegExp(`^(?:unhighlight|unselect|unpick|unmark|deselect)\\s+${LETTER}$`, 'i'), run: m => unhighlightBuilding(m[1]) },
      { re: /^clear\s+(?:highlights?|selection|selections|marks?)$/i, run: () => clearHighlights() },
      { re: new RegExp(`^(?:focus|zoom\\s+to|go\\s+to|fly\\s+to|show\\s+me)\\s+${LETTER}$`, 'i'), run: m => focusBuilding(m[1]) },
      { re: new RegExp(`^(?:info|describe|detail)\\s+${LETTER}$`, 'i'), run: m => infoAboutBuilding(m[1]) },
      { re: new RegExp(`^hide\\s+${LETTER}$`, 'i'), run: m => hideBuildingByLetter(m[1]) },
      { re: new RegExp(`^(?:show|reveal)\\s+${LETTER}$`, 'i'), run: m => showBuildingByLetter(m[1]) },
      { re: /^unhide\s+(?:all|everything)$/i, run: () => clearHidden() },
      { re: /^unhide$/i, run: () => clearHidden() },
      { re: new RegExp(`^unhide\\s+${LETTER}$`, 'i'), run: m => showBuildingByLetter(m[1]) },
      { re: /^list\s+hidden$/i, run: () => listHidden() },
      { re: /^clear\s+hidden$/i, run: () => clearHidden() },

      { re: /^(?:(?:add|create|new|make|build|draw)\s+)?zone\s+(?:at\s+)?(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s+(.+)$/i,
        run: m => {
            const lat = parseFloat(m[1]);
            const lon = parseFloat(m[2]);
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
                return logPrompt('error', `Invalid coordinates.`);
            const parsed = parseZoneArgs(m[3]);
            if (!parsed.radius || parsed.radius <= 0)
                return logPrompt('error', 'Please specify a radius.');
            if (!parsed.cls)
                return logPrompt('error', 'Please specify a class.');
            const id = `Z${++zoneIdCounter}`;
            zones.set(id, { id, center: [lon, lat], radiusMeters: parsed.radius, class: parsed.cls });
            refreshZones();
            saveZones();
            logPrompt('bot', `Created zone ${id}: ${parsed.cls}, r=${parsed.radius}m.`);
        }
      },

      { re: /^(?:(?:build|create|add|new|make|draw)\s+)?building\s+(?:at\s+)?(.+)$/i,
        run: m => {
            const parsed = parseBuildingArgs(m[1]);
            if (parsed.coords.length < 3)
                return logPrompt('error', `A building needs at least 3 coordinate pairs. Format: "build building 20m 45.443,35.557 45.444,35.558 45.444,35.557".`);
            const badCoord = parsed.coords.find(([lat, lon]) => Math.abs(lat) > 90 || Math.abs(lon) > 180);
            if (badCoord) return logPrompt('error', `Invalid coordinate.`);
            const height = (parsed.height !== null && parsed.height > 0) ? parsed.height : buildingDefaultHeight;
            const coords = parsed.coords.map(([lat, lon]) => [lon, lat]);
            const id = `custom-${++buildingIdCounter}`;
            customBuildings.set(id, { id, coords, height, base: 0, color: buildingDefaultColor });
            refreshBuildings();
            if (state.buildingLabels) updateBuildingLabels();
            saveCustomBuildings();
            const note = parsed.height !== null ? '' : ` (default ${buildingDefaultHeight}m)`;
            logPrompt('bot', `Created building ${id}: ${coords.length} vertices, ${height}m${note}.`);
        }
      },

      { re: /^(?:build|create|add|new|make)\s+(?:a\s+)?buildings?$/i,
        run: () => {
            logPrompt('error', 'To create a building from prompt, provide coordinates: "build building 20m 45.443,35.557 45.444,35.558 45.444,35.557"');
            logPrompt('info', 'Or click the "🏗️ Build building" button to draw interactively.');
        }
      },

      { re: /^(?:draw|start)\s+(?:a\s+)?buildings?$/i, run: () => startBuildingDrawing() },
      { re: /^(?:finish|done|close)\s+building$/i, run: () => finishBuilding() },
      { re: /^(?:cancel|discard)\s+building$/i, run: () => cancelBuilding() },
      { re: /^(?:demolish|start\s+demolishing)$/i, run: () => startBuildingDeleting() },
      { re: /^(?:stop|end|exit|done)\s+(?:demolishing|deleting\s+buildings?)$/i, run: () => { setBuildingDeleteActive(false); logPrompt('bot', 'Building deletion OFF.'); } },
      { re: /^(?:edit|modify|move)\s+buildings?$/i, run: () => startBuildingEdit() },
      { re: /^(?:stop|end|exit|done)\s+editing$/i, run: () => stopBuildingEdit() },
      { re: /^(?:delete|remove)\s+building$/i, run: () => deleteSelectedBuilding() },
      { re: /^(?:list|show)\s+(?:custom\s+)?buildings$/i, run: () => listCustomBuildings() },
      { re: /^clear\s+(?:custom\s+)?buildings$/i, run: () => clearAllCustomBuildings() },
      { re: /^building\s+height\s+(\d+(?:\.\d+)?)$/i, run: m => setBuildingHeight(parseFloat(m[1])) },
      { re: /^building\s+(?:color|colour)\s+(.+)$/i, run: m => setBuildingColor(m[1]) },
      { re: /^save\s+(?:custom\s+)?buildings$/i, run: () => { saveCustomBuildings(); logPrompt('bot', `Saved ${customBuildings.size} building(s).`); } },
      { re: /^load\s+(?:custom\s+)?buildings$/i, run: () => {
          const n = loadCustomBuildings();
          refreshBuildings();
          if (state.buildingLabels) updateBuildingLabels();
          updateSelectionOverlay();
          logPrompt('bot', `Loaded ${n} building(s).`);
      }},

      { re: /^undo(?:\s+(?:point|vertex|last))?$/i, run: () => {
          if (pendingBuilding) return logPrompt('info', 'Finish or cancel the height prompt first.');
          if (buildingDrawActive) undoBuildingVertex();
          else if (roadDrawActive) undoDraftPoint();
          else logPrompt('info', 'Nothing to undo.');
      } },

      { re: /^(?:draw|add|create|new|start)\s+roads?$/i, run: () => startRoadDrawing() },
      { re: /^(?:finish|done|end|complete|commit)\s+roads?$/i, run: () => finishRoad() },
      { re: /^(?:cancel|abort|discard)\s+roads?$/i, run: () => cancelRoad() },
      { re: /^undo\s+point$/i, run: () => undoDraftPoint() },
      { re: /^(?:delete|erase)\s+roads?$/i, run: () => startRoadDeleting() },
      { re: /^(?:stop|end|exit|done)\s+deleting$/i, run: () => { setRoadDeleteActive(false); logPrompt('bot', 'Road deletion OFF.'); } },
      { re: /^(?:clear|remove|delete)\s+(?:all\s+)?(?:drawn\s+)?roads?$/i, run: () => clearAllRoads() },
      { re: /^list\s+(?:drawn\s+)?roads$/i, run: () => listRoads() },
      { re: /^road\s+(?:color|colour)\s+(.+)$/i, run: m => setRoadColor(m[1]) },
      { re: /^road\s+width\s+(\d+(?:\.\d+)?)$/i, run: m => setRoadWidth(parseFloat(m[1])) },

      { re: /^(?:draw|add|create|new|start)\s+zones?$/i, run: () => startZoneDrawing() },
      { re: /^(?:finish|done|end|commit)\s+zones?$/i, run: () => {
          if (pendingZone) { showZoneClassPanel(); logPrompt('info', 'Choose a zone class.'); return; }
          logPrompt('info', 'Not drawing a zone.');
      } },
      { re: /^(?:cancel|abort|discard)\s+zones?$/i, run: () => cancelZone() },
      { re: /^(?:delete|erase)\s+zones?$/i, run: () => startZoneDeleting() },
      { re: /^(?:stop|end|exit|done)\s+deleting\s+zones?$/i, run: () => { setZoneDeleteActive(false); logPrompt('bot', 'Zone deletion OFF.'); } },
      { re: /^(?:clear|remove|delete)\s+all\s+zones$/i, run: () => clearAllZones() },
      { re: /^list\s+zones$/i, run: () => listZones() },
      { re: /^zone\s+(?:class|type)\s+(Z\d+)\s+(Flood|Green|Shade)$/i, run: m => setZoneClass(m[1].toUpperCase(), m[2]) },
      { re: /^zone\s+(?:class|type)\s+(Flood|Green|Shade)\s+(Z\d+)$/i, run: m => setZoneClass(m[2].toUpperCase(), m[1]) },
      { re: /^(?:info|describe)\s+zone\s+(Z\d+)$/i, run: m => infoAboutZone(m[1].toUpperCase()) },
      { re: /^(?:delete|remove)\s+zone\s+(Z\d+)$/i, run: m => {
          const id = m[1].toUpperCase();
          if (deleteZoneById(id)) logPrompt('bot', `Deleted zone ${id}.`);
          else logPrompt('error', `No zone "${id}".`);
      } },

      // ---- Traffic commands ----
      { re: /^traffic\s+(\d+)$/i, run: m => {
          const n = setTrafficCount(parseInt(m[1], 10));
          logPrompt('bot', `Traffic set to ${n} cars.`);
      }},
      { re: /^traffic\s+(?:on|start)$/i, run: () => {
          setTrafficCount(50);
          logPrompt('bot', 'Traffic ON (50 cars).');
      }},
      { re: /^traffic\s+(?:off|stop)$/i, run: () => {
          setTrafficCount(0);
          logPrompt('bot', 'Traffic OFF.');
      }},
      { re: /^clear\s+traffic$/i, run: () => {
          setTrafficCount(0);
          logPrompt('bot', 'Traffic cleared.');
      }},
      { re: /^refresh\s+(?:road\s+)?paths$/i, run: () => {
          const n = extractRoadPathsFromTiles();
          logPrompt('bot', `Road paths refreshed: ${n} paths.`);
      }},

      // ---- Shadows ----
      { re: /^(?:shadows?|ao|ambient\s+occlusion)\s+(?:on|enable)$/i,
        run: () => { state.ambientOcclusion = true; applyAmbientOcclusion(); applyBuildings(); logPrompt('bot', 'Shadows ON.'); } },
      { re: /^(?:shadows?|ao|ambient\s+occlusion)\s+(?:off|disable)$/i,
        run: () => { state.ambientOcclusion = false; applyAmbientOcclusion(); applyBuildings(); logPrompt('bot', 'Shadows OFF.'); } },
      { re: /^(?:shadows?|ao|ambient\s+occlusion)\s+(\d+(?:\.\d+)?)\s*%?$/i,
        run: m => {
            const v = parseFloat(m[1]);
            state.ambientOcclusion = true;
            state.aoIntensity = Math.min(1, Math.max(0, v > 1 ? v / 100 : v));
            applyAmbientOcclusion(); applyBuildings();
            logPrompt('bot', `Shadows intensity set to ${Math.round(state.aoIntensity * 100)}%.`);
        } },
      { re: /^(?:shadows?|ao|ambient\s+occlusion)\s+offset\s+(-?\d+(?:\.\d+)?)$/i,
        run: m => {
            state.aoOffset = Math.max(-40, Math.min(40, parseFloat(m[1])));
            applyAmbientOcclusion();
            logPrompt('bot', `Shadows offset set to ${state.aoOffset}px.`);
        } },

      { re: /^pick tiles?$/i, run: () => setTilePickerActive(true) },
      { re: /^stop picking$/i, run: () => setTilePickerActive(false) },
      { re: /^hide tile$/i, run: () => {
          const c = map.getCenter();
          const z = Math.round(map.getZoom());
          const { x, y } = lngLatToTile(c.lng, c.lat, z);
          hiddenTiles.set(`${z}/${x}/${y}`, { z, x, y });
          rebuildHiddenTileCovers();
          logPrompt('bot', `Hidden tile ${z}/${x}/${y}.`);
      }},
      { re: /^show all tiles$/i, run: () => {
          const n = hiddenTiles.size;
          hiddenTiles.clear();
          rebuildHiddenTileCovers();
          logPrompt('bot', `${n} tile(s) restored.`);
      }},
      { re: /^list hidden tiles$/i, run: () => {
          if (!hiddenTiles.size) return logPrompt('info', 'No tiles hidden.');
          logPrompt('info', `Hidden tiles: ${hiddenTiles.size}`);
          for (const k of hiddenTiles.keys()) logPrompt('info', '  ' + k);
      }},

      { re: /haze\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*%?\s*$/i,
        run: m => {
            const v = parseFloat(m[1]);
            state.hazeMode = 'force';
            state.hazeForce = Math.min(1, Math.max(0, v > 1 ? v / 100 : v));
            overlayEl.style.opacity = state.hazeForce;
            logPrompt('bot', `Haze set to ${Math.round(state.hazeForce * 100)}%.`);
        }},
      { re: /haze\s+(off|clear|none)$/i,
        run: () => { state.hazeMode = 'force'; state.hazeForce = 0; overlayEl.style.opacity = 0; logPrompt('bot', 'Haze cleared.'); }},
      { re: /haze\s+(auto|live)/i,
        run: () => { state.hazeMode = 'live'; weather.resetCache(); weather.update(); logPrompt('bot', 'Haze follows live visibility.'); }},

      { re: /roads?\s+(?:opacity|transparen(?:cy|t))\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*%?/i,
        run: m => {
            const v = parseFloat(m[1]);
            state.roadOpacity = Math.min(1, Math.max(0, v > 1 ? v / 100 : v));
            applyRoads();
            logPrompt('bot', `Road opacity ${Math.round(state.roadOpacity * 100)}%.`);
        }},
      { re: /roads?\s+(?:fill|color|colour)\s+(?:to\s+)?(.+)$/i,
        run: m => {
            const c = resolveColor(m[1]);
            if (!c) return logPrompt('error', `Unknown color: "${m[1]}"`);
            state.roadFill = c; applyRoads();
            logPrompt('bot', `Road fill set to ${c}.`);
        }},
      { re: /roads?\s+(?:to\s+)?(.+)$/i,
        run: m => {
            const c = resolveColor(m[1]);
            if (!c) return logPrompt('error', `Unknown color: "${m[1]}"`);
            state.roadFill = c; applyRoads();
            logPrompt('bot', `Road fill set to ${c}.`);
        }},
      { re: /(?:road\s+)?(?:border|edge|casing|outline)\s+(?:color\s+)?(?:to\s+)?(.+)$/i,
        run: m => {
            const c = resolveColor(m[1]);
            if (!c) return logPrompt('error', `Unknown color: "${m[1]}"`);
            state.casingColor = c; applyRoads();
            logPrompt('bot', `Road border set to ${c}.`);
        }},

      { re: /zoom\s+(?:to\s+)?(\d+(?:\.\d+)?)/i,
        run: m => { map.setZoom(parseFloat(m[1])); logPrompt('bot', `Zoom → ${m[1]}.`); }},
      { re: /pitch\s+(?:to\s+)?(\d+)/i,
        run: m => { map.setPitch(parseFloat(m[1])); logPrompt('bot', `Pitch → ${m[1]}°.`); }},
      { re: /bearing\s+(?:to\s+)?(-?\d+)/i,
        run: m => { map.setBearing(parseFloat(m[1])); logPrompt('bot', `Bearing → ${m[1]}°.`); }},
      { re: /(?:go|move|center|centre)\s+to\s+(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/i,
        run: m => {
            const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return logPrompt('error', 'Invalid coordinates.');
            map.easeTo({ center: [lon, lat], duration: 900 });
            logPrompt('bot', `Centering on ${lat}, ${lon}.`);
        }},

      { re: /(?:hide|disable|remove)\s+buildings?/i,
        run: () => { state.buildings = false; applyBuildings(); logPrompt('bot', 'All buildings hidden.'); }},
      { re: /(?:show|enable|display)\s+buildings?/i,
        run: () => { state.buildings = true; applyBuildings(); logPrompt('bot', 'All buildings shown.'); }},
      { re: /(?:hide|disable|remove)\s+(?:map\s+)?labels?/i,
        run: () => { state.labels = false; applyLabels(); logPrompt('bot', 'Map labels hidden.'); }},
      { re: /(?:show|enable|display)\s+(?:map\s+)?labels?/i,
        run: () => { state.labels = true; applyLabels(); logPrompt('bot', 'Map labels shown.'); }}
  ];

  function runPrompt(raw) {
      const t = String(raw || '').trim();
      if (!t) return;
      logPrompt('user', '› ' + t);
      for (const cmd of COMMANDS) {
          const m = t.match(cmd.re);
          if (m) {
              try { cmd.run(m); }
              catch (e) { logPrompt('error', 'Error: ' + e.message); console.error(e); }
              return;
          }
      }
      logPrompt('error', `Didn't understand: "${t}". Type "help".`);
  }

  promptSend.addEventListener('click', () => {
      const v = promptInput.value;
      promptInput.value = '';
      promptInput.focus();
      runPrompt(v);
  });
  promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); promptSend.click(); }
      if (e.key === 'Escape') { promptLog.classList.remove('visible'); promptInput.blur(); }
  });
  promptInput.addEventListener('focus', () => promptLog.classList.add('visible'));

  document.getElementById('tile-picker-btn').addEventListener('click', () => setTilePickerActive(!tilePickerActive));
  document.getElementById('road-draw-btn').addEventListener('click', () => { if (roadDrawActive) finishRoad(); else startRoadDrawing(); });
  document.getElementById('road-delete-btn').addEventListener('click', () => startRoadDeleting());
  document.getElementById('building-build-btn').addEventListener('click', () => {
      if (pendingBuilding) { focusHeightInput(); return; }
      if (buildingDrawActive) finishBuilding();
      else startBuildingDrawing();
  });
  document.getElementById('building-delete-btn').addEventListener('click', () => startBuildingDeleting());
  document.getElementById('building-edit-btn').addEventListener('click', () => { if (buildingEditActive) stopBuildingEdit(); else startBuildingEdit(); });
  document.getElementById('zone-draw-btn').addEventListener('click', () => {
      if (pendingZone) { showZoneClassPanel(); return; }
      if (zoneDrawActive) cancelZone();
      else startZoneDrawing();
  });
  document.getElementById('zone-delete-btn').addEventListener('click', () => startZoneDeleting());
  document.getElementById('ao-toggle-btn').addEventListener('click', () => {
      state.ambientOcclusion = !state.ambientOcclusion;
      applyAmbientOcclusion();
      applyBuildings();
      logPrompt('bot', `Shadows ${state.ambientOcclusion ? 'ON' : 'OFF'}.`);
  });
  document.querySelectorAll('.zone-class-btn').forEach(btn => {
      btn.addEventListener('click', () => commitPendingZone(btn.dataset.class));
  });
  document.getElementById('zone-class-cancel').addEventListener('click', () => cancelPendingZone());

  document.getElementById('height-ok').addEventListener('click', () => commitPendingBuilding(readHeightInput()));
  document.getElementById('height-cancel').addEventListener('click', () => cancelPendingBuilding());
  document.getElementById('height-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitPendingBuilding(readHeightInput()); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelPendingBuilding(); }
  });

  document.addEventListener('keydown', (e) => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      if (typing) return;

      if (pendingZone) {
          if (e.key === 'Escape') { e.preventDefault(); cancelPendingZone(); }
          return;
      }
      if (pendingBuilding) {
          if (e.key === 'Escape') { e.preventDefault(); cancelPendingBuilding(); }
          else if (e.key === 'Enter') { e.preventDefault(); commitPendingBuilding(readHeightInput()); }
          return;
      }
      if (zoneDrawActive) { if (e.key === 'Escape') { e.preventDefault(); cancelZone(); } return; }
      if (zoneDeleteActive && e.key === 'Escape') { e.preventDefault(); setZoneDeleteActive(false); return; }
      if (buildingDrawActive) {
          if (e.key === 'Escape') { e.preventDefault(); cancelBuilding(); }
          else if (e.key === 'Enter') { e.preventDefault(); finishBuilding(); }
          else if (e.key === 'Backspace' || (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey))) {
              e.preventDefault(); undoBuildingVertex();
          }
          return;
      }
      if (buildingEditActive) {
          if (e.key === 'Escape') {
              e.preventDefault();
              if (selectedBuildingId) deselectBuilding();
              else stopBuildingEdit();
          }
          return;
      }
      if (buildingDeleteActive) {
          if (e.key === 'Escape') { e.preventDefault(); setBuildingDeleteActive(false); }
          return;
      }
      if (roadDrawActive) {
          if (e.key === 'Escape') { e.preventDefault(); cancelRoad(); }
          else if (e.key === 'Enter') { e.preventDefault(); finishRoad(); }
          else if (e.key === 'Backspace' || (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey))) {
              e.preventDefault(); undoDraftPoint();
          }
          return;
      }
      if (roadDeleteActive && e.key === 'Escape') { e.preventDefault(); setRoadDeleteActive(false); }
  });

  map.on('mousedown', (e) => { if (buildingEditActive) tryStartBuildingDrag(e); });
  map.on('mouseup', () => { if (buildingDragState) endBuildingDrag(); });

  map.on('click', (e) => {
      if (suppressNextMapClick) { suppressNextMapClick = false; return; }

      if (zoneDrawActive) {
          if (pendingZone) return;
          if (!zoneDraftCenter) placeZoneCenter(e.lngLat.lng, e.lngLat.lat);
          else placeZoneRadius(e.lngLat.lng, e.lngLat.lat);
          return;
      }
      if (zoneDeleteActive) {
          const z = findZoneAtPoint(e.point);
          if (!z) return logPrompt('info', 'No zone at that spot.');
          deleteZoneById(z.id);
          clearZoneDeleteHover();
          return;
      }
      if (buildingDrawActive) {
          if (pendingBuilding) return;
          if (buildingDraftCoords.length >= 3) {
              const firstPx = map.project(buildingDraftCoords[0]);
              const dist = Math.hypot(firstPx.x - e.point.x, firstPx.y - e.point.y);
              if (dist < 12) { finishBuilding(); return; }
          }
          addBuildingVertex(e.lngLat.lng, e.lngLat.lat);
          return;
      }
      if (buildingEditActive) {
          let hits = [];
          try { hits = map.queryRenderedFeatures(e.point, { layers: ['buildings-live'] }); }
          catch (_) { hits = []; }
          const custom = hits.find(h => h.properties && h.properties.custom_id);
          if (custom) selectBuilding(custom.properties.custom_id);
          else deselectBuilding();
          return;
      }
      if (buildingDeleteActive) {
          const entry = findBuildingAtPoint(e.point);
          if (!entry) return logPrompt('info', 'No building at that spot.');
          if (entry.kind === 'custom') {
              const id = entry.id;
              customBuildings.delete(id);
              if (selectedBuildingId === id) {
                  selectedBuildingId = null;
                  updateSelectionOverlay();
                  updateBuildingEditButton();
              }
              refreshBuildings();
              if (state.buildingLabels) updateBuildingLabels();
              saveCustomBuildings();
              logPrompt('bot', `Deleted custom building ${id}.`);
          } else {
              const letter = keyToLetter.get(entry.key);
              hiddenBuildingKeys.add(entry.key);
              highlightedBuildings.delete(entry.key);
              rebuildHighlights();
              refreshBuildings();
              updateBuildingLabels();
              logPrompt('bot', letter ? `Hid ${letter}.` : `Hid OSM building.`);
          }
          clearBuildingDeleteHover();
          return;
      }
      if (roadDrawActive) { addDraftPoint(e.lngLat.lng, e.lngLat.lat); return; }
      if (roadDeleteActive) {
          const road = findRoadAtPoint(e.point);
          if (!road) return logPrompt('info', 'No drawn road at that spot.');
          if (deleteRoadById(road.id)) {
              logPrompt('bot', `Deleted ${road.id}.`);
              const still = findRoadAtPoint(e.point);
              if (still) setDeleteHover(still); else clearDeleteHover();
          }
          return;
      }
      if (!tilePickerActive) return;
      toggleTileAt(e.lngLat.lng, e.lngLat.lat);
  });

  map.on('mousemove', (e) => {
      if (zoneDrawActive) {
          if (pendingZone) return;
          if (zoneDraftCenter) {
              zoneDraftRadiusM = haversineMeters(zoneDraftCenter[0], zoneDraftCenter[1], e.lngLat.lng, e.lngLat.lat);
              updateZoneDraftPreview();
          }
          return;
      }
      if (zoneDeleteActive) {
          const z = findZoneAtPoint(e.point);
          if (z) { setZoneDeleteHover(z); map.getCanvas().style.cursor = 'pointer'; }
          else { clearZoneDeleteHover(); map.getCanvas().style.cursor = 'crosshair'; }
          return;
      }
      if (buildingDragState) { updateBuildingDrag(e); return; }
      if (buildingDrawActive) {
          if (pendingBuilding) return;
          buildingDraftCursor = [e.lngLat.lng, e.lngLat.lat];
          setBuildingDraftData();
          return;
      }
      if (buildingEditActive) {
          let hovering = false;
          if (map.getLayer('building-vertices')) {
              let vHits = [];
              try { vHits = map.queryRenderedFeatures(e.point, { layers: ['building-vertices'] }); }
              catch (_) { vHits = []; }
              hovering = vHits.length > 0;
          }
          map.getCanvas().style.cursor = hovering ? 'grab' : '';
          return;
      }
      if (buildingDeleteActive) {
          const entry = findBuildingAtPoint(e.point);
          if (entry) { setBuildingDeleteHover(entry); map.getCanvas().style.cursor = 'pointer'; }
          else { clearBuildingDeleteHover(); map.getCanvas().style.cursor = 'crosshair'; }
          return;
      }
      if (roadDrawActive) { draftCursor = [e.lngLat.lng, e.lngLat.lat]; setDraftData(); return; }
      if (roadDeleteActive) {
          const road = findRoadAtPoint(e.point);
          if (road) { setDeleteHover(road); map.getCanvas().style.cursor = 'pointer'; }
          else { clearDeleteHover(); map.getCanvas().style.cursor = 'crosshair'; }
          return;
      }
      if (!tilePickerActive) return;
      updateTileHover(e.lngLat.lng, e.lngLat.lat);
  });

  map.on('contextmenu', (e) => {
      if (pendingZone) { e.preventDefault(); return; }
      if (zoneDrawActive) { e.preventDefault(); cancelZone(); return; }
      if (pendingBuilding) { e.preventDefault(); return; }
      if (buildingDrawActive) { e.preventDefault(); undoBuildingVertex(); return; }
      if (roadDrawActive) { e.preventDefault(); undoDraftPoint(); }
  });

  map.getCanvas().addEventListener('mouseleave', () => {
      clearTileHover();
      clearDeleteHover();
      clearBuildingDeleteHover();
      clearZoneDeleteHover();
      if (buildingDragState) endBuildingDrag();
  });

  const parkController = createParkController({ map, center: CENTER, dbg });

  map.on('load', () => {
      dbg('Map loaded.');
      map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.6, position: [1.15, 210, 30] });

      detectFontStack();

      let hiddenSymbols = 0;
      for (const layer of map.getStyle().layers) {
          if (layer.type === 'symbol') {
              map.setLayoutProperty(layer.id, 'visibility', state.labels ? 'visible' : 'none');
              hiddenSymbols++;
          }
      }
      dbg('Symbol layers hidden: ' + hiddenSymbols);

      applyRoads();
      addSmoothFade();
      addBlackVoid();

      if (!map.getSource('openfreemap')) {
          map.addSource('openfreemap', {
              url: `https://tiles.openfreemap.org/planet`,
              type: 'vector'
          });
      }

      setupLiveBuildingsLayer();
      ensureRoadLoaderLayer();
      createRoadLayers();
      createBuildingEditorLayers();
      createBuildingDeleteLayers();
      createZoneLayers();
      rebuildHiddenTileCovers();

      const loadedCount = loadCustomBuildings();
      if (loadedCount) dbg(`Loaded ${loadedCount} custom building(s).`);

      const loadedZones = loadZones();
      if (loadedZones) {
          dbg(`Loaded ${loadedZones} zone(s).`);
          refreshZones();
      }

      parkController.buildAllParks();

      map.on('styledata', () => {
          schedulePositionRoadLayers();
          scheduleBringBuildingEditorToTop();
          scheduleBringZoneTopLayersToTop();
      });

      if (state.hazeMode === 'force') {
          overlayEl.style.opacity = state.hazeForce;
          dbg(`Haze forced to ${Math.round(state.hazeForce * 100)}%.`);
      }

      applyAmbientOcclusion();

      // Traffic setup
      bindTrafficSlider();
      setupTrafficOverlay();

      setTimeout(() => {
          if (!initialPopulateDone) {
              initialPopulateDone = true;
              refreshBuildings();
              if (state.buildingLabels) updateBuildingLabels();
          } else {
              refreshBuildings();
              if (state.buildingLabels) updateBuildingLabels();
          }
          extractRoadPathsFromTiles();
          if (roadPaths.size === 0) {
              map.once('idle', () => extractRoadPathsFromTiles());
          }
      }, 1500);

      setTimeout(() => reportTileStats(true), 1500);
      logPrompt('info', 'Ready. Haze = 20%, cast shadows ON, traffic available.');
      logPrompt('info', 'Drag the 🚗 Traffic slider (top-left) or type "traffic 50".');
      logPrompt('info', 'Type "help" for the full command list.');
  });
