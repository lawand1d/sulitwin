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
import { createRoadLayerController, createRoadLifecycleController } from './src/road-layers.js';
import {
  createBuildingEditorController,
  createBuildingSelectionController,
  createBuildingInteractionController,
  createBuildingLifecycleController
} from './src/building-editor.js';
import { createBuildingLabelController } from './src/building-labels.js';
import { createBuildingNavigationController } from './src/building-navigation.js';
import { createZoneController } from './src/zones.js';

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
  const buildingEditor = createBuildingEditorController({ map, dbg });
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
  let buildingDragState = null;
  const buildingLifecycle = createBuildingLifecycleController({
      map,
      customBuildings,
      getBuildingIdCounter: () => buildingIdCounter,
      setBuildingIdCounter: (n) => { buildingIdCounter = n; },
      getBuildingDraftCoords: () => buildingDraftCoords,
      setBuildingDraftCoords: (v) => { buildingDraftCoords = v; },
      getBuildingDraftCursor: () => buildingDraftCursor,
      setBuildingDraftCursor: (v) => { buildingDraftCursor = v; },
      getPendingBuilding: () => pendingBuilding,
      setPendingBuilding: (v) => { pendingBuilding = v; },
      getBuildingDrawActive: () => buildingDrawActive,
      setBuildingDrawActive: (v) => { buildingDrawActive = v; },
      getBuildingEditActive: () => buildingEditActive,
      setBuildingEditActive: (v) => { buildingEditActive = v; },
      getBuildingDeleteActive: () => buildingDeleteActive,
      setBuildingDeleteActive: (v) => { buildingDeleteActive = v; },
      getSelectedBuildingId: () => selectedBuildingId,
      setSelectedBuildingId: (v) => { selectedBuildingId = v; },
      getBuildingDefaultHeight: () => buildingDefaultHeight,
      setBuildingDefaultHeight: (v) => { buildingDefaultHeight = v; },
      getBuildingDefaultColor: () => buildingDefaultColor,
      setBuildingDefaultColor: (v) => { buildingDefaultColor = v; },
      updateSelectionOverlay,
      refreshBuildings,
      saveCustomBuildings,
      state,
      updateBuildingLabels,
      updateBuildingBuildButton,
      updateBuildingDeleteButton,
      updateBuildingEditButton,
      createBuildingEditorLayers,
      createBuildingDeleteLayers,
      clearBuildingDeleteHover,
      logPrompt,
      resolveColor,
      centerOfCoordinates,
      getTilePickerActive: () => tilePickerActive,
      setTilePickerActive: (v) => { tilePickerActive = v; },
      cancelRoad,
      getRoadDrawActive: () => roadDrawActive,
      setRoadDrawActive: (v) => { roadDrawActive = v; },
      setRoadDeleteActive: (v) => { roadDeleteActive = v; },
      getRoadDeleteActive: () => roadDeleteActive,
      cancelZone,
      setZoneDeleteActive: (v) => { zoneDeleteActive = v; },
      getZoneDeleteActive: () => zoneDeleteActive,
      setZoneDrawActive: (v) => { zoneDrawActive = v; },
      getZoneDrawActive: () => zoneDrawActive,
      getBuildingDeleteActiveState: () => buildingDeleteActive,
      getTilePickerState: () => tilePickerActive,
      getRoadDrawState: () => roadDrawActive,
      getRoadDeleteState: () => roadDeleteActive,
      getZoneDrawState: () => zoneDrawActive,
      getZoneDeleteState: () => zoneDeleteActive,
      cancelBuilding,
      stopBuildingEdit,
      updateBuildingDraftData: setBuildingDraftData
  });
  const buildingSelection = createBuildingSelectionController({
      map,
      customBuildings,
      hiddenBuildingKeys,
      buildingKey,
      getSelectedBuildingId: () => selectedBuildingId,
      setSelectedBuildingId: (id) => { selectedBuildingId = id; },
      updateBuildingEditButton,
      logPrompt
  });
  const buildingInteraction = createBuildingInteractionController({
      map,
      customBuildings,
      hiddenBuildingKeys,
      buildingKey,
      getSelectedBuildingId: () => selectedBuildingId,
      setSelectedBuildingId: (id) => { selectedBuildingId = id; },
      updateSelectionOverlay,
      getBuildingDragState: () => buildingDragState,
      setBuildingDragState: (state) => { buildingDragState = state; },
      saveCustomBuildings,
      logPrompt
  });
  let buildingDrawActive = false;
  let buildingEditActive = false;
  let buildingDraftCoords = [];
  let buildingDraftCursor = null;
  let buildingIdCounter = 0;
  let buildingDefaultHeight = 20;
  let buildingDefaultColor = '#7ef29d';
  let selectedBuildingId = null;
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
  const buildingLabelController = createBuildingLabelController({
      map,
      state,
      logPrompt,
      numToLetters,
      displayHeight,
      detectFontStack,
      getCurrentVisibleBuildings: () => currentVisibleBuildings,
      getLabeledBuildings: () => labeledBuildings,
      getHighlightedBuildings: () => highlightedBuildings,
      getHiddenBuildingKeys: () => hiddenBuildingKeys,
      getKeyToLetter: () => keyToLetter,
      getLetterToKey: () => letterToKey,
      getNextLetterIndex: () => nextLetterIndex,
      setNextLetterIndex: (v) => { nextLetterIndex = v; },
      refreshBuildings,
      maxBuildingLabels: MAX_BUILDING_LABELS
  });
  const buildingNavigationController = createBuildingNavigationController({
      map,
      lookupBuilding,
      hiddenBuildingKeys,
      highlightedBuildings,
      logPrompt
  });

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
          const before = map.getLayer('road-label') ? 'road-label' : undefined;
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
                      15, 0, 16, ['coalesce', ['get', 'render_height'], ['get', 'height'], 20]
                  ],
                  'fill-extrusion-base': [
                      'interpolate', ['linear'], ['zoom'],
                      15, 0, 16, ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0]
                  ]
              }
          }, before);
      }
      map.addSource('buildings-live-src', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
      });
      map.addSource('buildings-shadow-src', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
      });
      const shadowBefore = map.getLayer('buildings-live') ? 'buildings-live' : undefined;
      map.addLayer({
          id: 'buildings-shadow',
          type: 'fill',
          source: 'buildings-shadow-src',
          paint: {
              'fill-color': '#000000',
              'fill-opacity': 0.45,
              'fill-translate': [state.aoOffset, state.aoOffset]
          }
      }, shadowBefore);
      const layerBefore = map.getLayer('road-label') ? 'road-label' : undefined;
      map.addLayer({
          id: 'buildings-live',
          type: 'fill-extrusion',
          source: 'buildings-live-src',
          minzoom: 15,
          paint: {
              'fill-extrusion-opacity': 1,
              'fill-extrusion-color': [
                  'case',
                  ['has', 'custom_color'],
                  ['get', 'custom_color'],
                  ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], ['get', 'height'], 20],
                      0, 'lightgray', 200, 'royalblue', 400, 'lightblue']
              ],
              'fill-extrusion-height': [
                  'max',
                  3,
                  ['coalesce', ['get', 'render_height'], ['get', 'height'], 20]
              ],
              'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
              'fill-extrusion-vertical-gradient': true
          }
      }, layerBefore);
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
      buildingLabelController.updateBuildingLabels();
  }

  function rebuildHighlights() {
      buildingLabelController.rebuildHighlights();
  }

  function lookupBuilding(letterRaw) {
      return buildingLabelController.lookupBuilding(letterRaw);
  }

  function highlightBuilding(letterRaw, color) {
      buildingLabelController.highlightBuilding(letterRaw, color);
  }
  function unhighlightBuilding(letterRaw) {
      buildingLabelController.unhighlightBuilding(letterRaw);
  }
  function clearHighlights() {
      buildingLabelController.clearHighlights();
  }

  function hideBuildingByLetter(letterRaw) {
      buildingLabelController.hideBuildingByLetter(letterRaw);
  }
  function showBuildingByLetter(letterRaw) {
      buildingLabelController.showBuildingByLetter(letterRaw);
  }
  function listHidden() {
      buildingLabelController.listHidden();
  }
  function clearHidden() {
      buildingLabelController.clearHidden();
  }
  function focusBuilding(letterRaw) {
      buildingNavigationController.focusBuilding(letterRaw);
  }
  function infoAboutBuilding(letterRaw) {
      buildingNavigationController.infoAboutBuilding(letterRaw);
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
  const roadLifecycle = createRoadLifecycleController({
      map,
      dbg,
      getRoadDrawActive: () => roadDrawActive,
      setRoadDrawActive: (v) => { roadDrawActive = v; },
      getRoadDeleteActive: () => roadDeleteActive,
      setRoadDeleteActive: (v) => { roadDeleteActive = v; },
      getDraftCoords: () => draftCoords,
      setDraftCoords: (v) => { draftCoords = v; },
      getDraftCursor: () => draftCursor,
      setDraftCursor: (v) => { draftCursor = v; },
      getDrawnRoads: () => drawnRoads,
      setDrawnRoads: (v) => { drawnRoads = v; },
      getHoveredDeleteRoadId: () => hoveredDeleteRoadId,
      setHoveredDeleteRoadId: (v) => { hoveredDeleteRoadId = v; },
      getRoadIdCounter: () => roadIdCounter,
      setRoadIdCounter: (v) => { roadIdCounter = v; },
      getRoadDrawColor: () => roadDrawColor,
      setRoadDrawColor: (v) => { roadDrawColor = v; },
      getRoadDrawWidth: () => roadDrawWidth,
      setRoadDrawWidth: (v) => { roadDrawWidth = v; },
      createRoadLayers,
      positionRoadLayers,
      refreshDrawnRoads,
      setDraftData,
      clearDeleteHover,
      updateRoadDrawButton,
      updateRoadDeleteButton,
      getTilePickerActive: () => tilePickerActive,
      setTilePickerActive,
      getBuildingDrawActive: () => buildingDrawActive,
      cancelBuilding,
      getBuildingEditActive: () => buildingEditActive,
      stopBuildingEdit,
      getBuildingDeleteActive: () => buildingDeleteActive,
      setBuildingDeleteActive,
      getZoneDrawActive: () => zoneDrawActive,
      cancelZone,
      getZoneDeleteActive: () => zoneDeleteActive,
      setZoneDeleteActive,
      logPrompt,
      resolveColor
  });

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
      roadLifecycle.setDraftData();
  }

  function setDeleteHover(road) {
      roadLifecycle.setDeleteHover(road);
  }
  function clearDeleteHover() {
      roadLifecycle.clearDeleteHover();
  }

  function setRoadDrawActive(active) {
      roadLifecycle.setRoadDrawState(active);
  }

  function setRoadDeleteActive(active) {
      roadLifecycle.setRoadDeleteState(active);
  }

  function startRoadDrawing() {
      roadLifecycle.startRoadDrawing();
  }
  function startRoadDeleting() {
      roadLifecycle.startRoadDeleting();
  }

  function finishRoad() {
      roadLifecycle.finishRoad();
  }
  function cancelRoad() {
      roadLifecycle.cancelRoad();
  }
  function addDraftPoint(lon, lat) {
      roadLifecycle.addDraftPoint(lon, lat);
  }
  function undoDraftPoint() {
      roadLifecycle.undoDraftPoint();
  }
  function clearAllRoads() {
      roadLifecycle.clearAllRoads();
  }
  function listRoads() {
      roadLifecycle.listRoads();
  }
  function deleteRoadById(id) {
      return roadLifecycle.deleteRoadById(id);
  }
  function findRoadAtPoint(point) {
      return roadLifecycle.findRoadAtPoint(point);
  }
  function setRoadColor(name) {
      roadLifecycle.setRoadColor(name);
  }
  function setRoadWidth(n) {
      roadLifecycle.setRoadWidth(n);
  }

  const BUILDING_OVERLAY_LAYER_IDS = buildingEditor.BUILDING_OVERLAY_LAYER_IDS;

  function createBuildingEditorLayers() {
      buildingEditor.createBuildingEditorLayers({ buildingDefaultColor });
  }

  function createBuildingDeleteLayers() {
      buildingEditor.createBuildingDeleteLayers();
  }

  function bringBuildingEditorToTop() {
      buildingEditor.bringBuildingEditorToTop();
  }

  let buildingOverlaysPosScheduled = false;
  function scheduleBringBuildingEditorToTop() {
      buildingEditor.scheduleBringBuildingEditorToTop();
  }

  function setBuildingDraftData() {
      buildingLifecycle.setBuildingDraftData();
  }

  function updateSelectionOverlay() {
      buildingSelection.updateSelectionOverlay();
  }

  function findBuildingAtPoint(point) {
      return buildingSelection.findBuildingAtPoint(point);
  }

  function setBuildingDeleteHover(entry) {
      buildingSelection.setBuildingDeleteHover(entry);
  }
  function clearBuildingDeleteHover() {
      buildingSelection.clearBuildingDeleteHover();
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
      buildingLifecycle.showHeightPanel(defaultHeight);
  }
  function hideHeightPanel() {
      buildingLifecycle.hideHeightPanel();
  }
  function focusHeightInput() {
      buildingLifecycle.focusHeightInput();
  }
  function readHeightInput() {
      return buildingLifecycle.readHeightInput();
  }

  function commitPendingBuilding(height) {
      const id = `custom-${++buildingIdCounter}`;
      console.warn('Deprecated commitPendingBuilding path; controller handles commit.', { id, height });
      buildingLifecycle.commitPendingBuilding();
  }
  function cancelPendingBuilding() {
      buildingLifecycle.cancelPendingBuilding();
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
      buildingLifecycle.startBuildingDrawing();
  }
  function startBuildingDeleting() {
      buildingLifecycle.startBuildingDeleting();
  }
  function addBuildingVertex(lon, lat) {
      buildingLifecycle.addBuildingVertex(lon, lat);
  }
  function undoBuildingVertex() {
      buildingLifecycle.undoBuildingVertex();
  }
  function finishBuilding() {
      buildingLifecycle.finishBuilding();
  }
  function cancelBuilding() {
      buildingLifecycle.cancelBuilding();
  }
  function startBuildingEdit() {
      buildingLifecycle.startBuildingEdit();
  }
  function stopBuildingEdit() {
      buildingLifecycle.stopBuildingEdit();
  }
  function selectBuilding(id) {
      buildingSelection.selectBuilding(id);
  }
  function deselectBuilding() {
      buildingSelection.deselectBuilding();
  }
  function deleteSelectedBuilding() {
      buildingLifecycle.deleteSelectedBuilding();
  }
  function clearAllCustomBuildings() {
      buildingLifecycle.clearAllCustomBuildings();
  }
  function listCustomBuildings() {
      buildingLifecycle.listCustomBuildings();
  }
  function setBuildingHeight(n) {
      buildingLifecycle.setBuildingHeight(n);
  }
  function setBuildingColor(name) {
      buildingLifecycle.setBuildingColor(name);
  }
  function tryStartBuildingDrag(e) {
      return buildingInteraction.tryStartBuildingDrag(e, { buildingEditActive, selectedBuildingId, selected: selectedBuildingId ? customBuildings.get(selectedBuildingId) : null });
  }
  function updateBuildingDrag(e) {
      buildingInteraction.updateBuildingDrag(e);
  }
  function endBuildingDrag() {
      buildingInteraction.endBuildingDrag();
  }

  const zoneController = createZoneController({
      map,
      dbg,
      detectFontStack,
      haversineMeters,
      zoneCircleCoords,
      ZONE_CLASSES,
      getZones: () => zones,
      getZoneIdCounter: () => zoneIdCounter,
      setZoneIdCounter: (v) => { zoneIdCounter = v; },
      getZoneDrawActive: () => zoneDrawActive,
      setZoneDrawActive: (v) => { zoneDrawActive = v; },
      getZoneDraftCenter: () => zoneDraftCenter,
      setZoneDraftCenter: (v) => { zoneDraftCenter = v; },
      getZoneDraftRadiusM: () => zoneDraftRadiusM,
      setZoneDraftRadiusM: (v) => { zoneDraftRadiusM = v; },
      getZoneDeleteActive: () => zoneDeleteActive,
      setZoneDeleteActive: (v) => { zoneDeleteActive = v; },
      getHoveredDeleteZoneId: () => hoveredDeleteZoneId,
      setHoveredDeleteZoneId: (v) => { hoveredDeleteZoneId = v; },
      getPendingZone: () => pendingZone,
      setPendingZone: (v) => { pendingZone = v; },
      getZoneDefaultClass: () => zoneDefaultClass,
      setZoneDefaultClass: (v) => { zoneDefaultClass = v; },
      saveZones: () => saveZones(),
      loadZones: () => loadZones(),
      zoneStorageKey: ZONE_STORAGE_KEY
  });

  const ZONE_TOP_LAYER_IDS = zoneController.ZONE_TOP_LAYER_IDS;

  function createZoneLayers() {
      zoneController.createZoneLayers();
  }

  function bringZoneTopLayersToTop() {
      zoneController.bringZoneTopLayersToTop();
  }

  function scheduleBringZoneTopLayersToTop() {
      zoneController.scheduleBringZoneTopLayersToTop();
  }

  function refreshZones() {
      zoneController.refreshZones();
      updateZoneDrawButton();
      updateZoneDeleteButton();
      if (hoveredDeleteZoneId && !zones.has(hoveredDeleteZoneId)) clearZoneDeleteHover();
  }

  function updateZoneDraftPreview() {
      zoneController.updateZoneDraftPreview();
  }

  function setZoneDeleteHover(zone) {
      zoneController.setZoneDeleteHover(zone);
  }
  function clearZoneDeleteHover() {
      zoneController.clearZoneDeleteHover();
  }
  function findZoneAtPoint(point) {
      return zoneController.findZoneAtPoint(point);
  }

  function updateZoneDrawButton() {
      zoneController.updateZoneDrawButton();
  }
  function updateZoneDeleteButton() {
      zoneController.updateZoneDeleteButton();
  }

  function setZoneDrawActive(active) {
      zoneController.setZoneDrawActive(active);
  }
  function setZoneDeleteActive(active) {
      zoneController.setZoneDeleteActive(active);
  }

  function startZoneDrawing() {
      zoneController.startZoneDrawing();
      logPrompt('bot', 'Zone drawing ON — click to place center, then radius.');
  }
  function startZoneDeleting() {
      zoneController.startZoneDeleting();
      logPrompt('bot', 'Zone deletion ON.');
  }
  function cancelZone() {
      zoneController.cancelZone();
      logPrompt('bot', 'Zone drawing cancelled.');
  }
  function placeZoneCenter(lon, lat) {
      zoneController.placeZoneCenter(lon, lat);
  }
  function placeZoneRadius(lon, lat) {
      zoneController.placeZoneRadius(lon, lat);
      if (pendingZone) showZoneClassPanel();
  }
  function showZoneClassPanel() {
      zoneController.showZoneClassPanel();
  }
  function hideZoneClassPanel() {
      zoneController.hideZoneClassPanel();
  }
  function commitPendingZone(zoneClass) {
      const created = zoneController.commitPendingZone(zoneClass);
      if (created) {
          const id = `Z${zoneIdCounter}`;
          logPrompt('bot', `Created zone ${id} (${zoneClass}, r=${zones.get(id).radiusMeters.toFixed(1)} m).`);
      }
  }
  function cancelPendingZone() {
      zoneController.cancelPendingZone();
      logPrompt('bot', 'Zone creation cancelled.');
  }
  function deleteZoneById(id) {
      return zoneController.deleteZoneById(id);
  }
  function clearAllZones() {
      const n = zoneController.clearAllZones();
      if (n) logPrompt('bot', `${n} zone(s) removed.`);
      else logPrompt('info', 'No zones.');
  }
  function listZones() {
      const all = zoneController.listZones();
      if (!all.length) return logPrompt('info', 'No zones yet.');
      logPrompt('info', `Zones: ${all.length}`);
      for (const z of all) {
          const [lon, lat] = z.center;
          logPrompt('info', `  ${z.id}  ${z.class}  r=${z.radiusMeters.toFixed(1)}m  @ ${lat.toFixed(5)},${lon.toFixed(5)}`);
      }
  }
  function setZoneClass(id, cls) {
      const ok = zoneController.setZoneClass(id, cls);
      if (!ok) return logPrompt('error', `Unknown class: "${cls}".`);
      logPrompt('bot', `Zone ${id} class → ${cls}.`);
  }
  function infoAboutZone(id) {
      const info = zoneController.infoAboutZone(id);
      if (!info) return logPrompt('error', `No zone "${id}".`);
      logPrompt('info', `Zone ${info.zone.id}`);
      logPrompt('info', `  class:  ${info.zone.class}`);
      logPrompt('info', `  center: ${info.lat.toFixed(6)}, ${info.lon.toFixed(6)}`);
      logPrompt('info', `  radius: ${info.zone.radiusMeters.toFixed(1)} m`);
      logPrompt('info', `  area:   ${Math.round(info.area)} m²`);
  }
  function saveZones() {
      zoneController.saveZonesState();
  }
  function loadZones() {
      return zoneController.loadZonesState();
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
  map.on('mouseup', () => { if (buildingInteraction.getBuildingDragState()) endBuildingDrag(); });

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
      if (buildingInteraction.getBuildingDragState()) { updateBuildingDrag(e); return; }
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
      if (buildingInteraction.getBuildingDragState()) endBuildingDrag();
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
