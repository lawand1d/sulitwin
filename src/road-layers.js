export function createRoadLayerController({ map, dbg }) {
  const ROAD_LAYER_IDS = ['drawn-roads', 'road-delete-hover-glow', 'road-delete-hover', 'road-draft-line', 'road-draft-points'];

  function createRoadLayers({ drawnRoads, roadDrawActive, roadDrawWidth, roadDrawColor, draftCoords, draftCursor, roadDeleteActive, refreshDrawnRoads, setDraftData, updateRoadDrawButton, updateRoadDeleteButton }) {
    if (!map.getSource('drawn-roads-src')) {
      map.addSource('drawn-roads-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('road-draft-src')) {
      map.addSource('road-draft-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('road-draft-points-src')) {
      map.addSource('road-draft-points-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('road-delete-hover-src')) {
      map.addSource('road-delete-hover-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('drawn-roads')) {
      map.addLayer({
        id: 'drawn-roads', type: 'line', source: 'drawn-roads-src',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ff0000',
          'line-width': ['interpolate', ['exponential', 2], ['zoom'], 15, ['*', ['coalesce', ['get', 'width'], 6], 0.257], 20, ['*', ['coalesce', ['get', 'width'], 6], 8.23]],
          'line-opacity': 1
        }
      });
    }
    if (!map.getLayer('road-delete-hover-glow')) {
      map.addLayer({
        id: 'road-delete-hover-glow', type: 'line', source: 'road-delete-hover-src',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 26, 'line-opacity': 0.85, 'line-blur': 3 }
      });
    }
    if (!map.getLayer('road-delete-hover')) {
      map.addLayer({
        id: 'road-delete-hover', type: 'line', source: 'road-delete-hover-src',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffeb3b', 'line-width': 14, 'line-opacity': 1 }
      });
    }
    if (!map.getLayer('road-draft-line')) {
      map.addLayer({
        id: 'road-draft-line', type: 'line', source: 'road-draft-src',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff0000', 'line-width': 4, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 }
      });
    }
    if (!map.getLayer('road-draft-points')) {
      map.addLayer({
        id: 'road-draft-points', type: 'circle', source: 'road-draft-points-src',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#ff0000',
          'circle-stroke-width': 2
        }
      });
    }
    positionRoadLayers();
    refreshDrawnRoads();
    setDraftData();
    dbg('Road layers created.');
  }

  function roadLayersArePositioned() {
    let layers;
    try { layers = map.getStyle().layers; } catch (e) { return true; }
    if (!layers || !layers.length) return true;
    const idxBL = layers.findIndex(l => l.id === 'buildings-live');
    if (idxBL < 0) return true;
    const idxDR = layers.findIndex(l => l.id === 'drawn-roads');
    if (idxDR < 0) return true;
    const idxDP = layers.findIndex(l => l.id === 'road-draft-points');
    return idxDR < idxBL && (idxDP < 0 || idxDP < idxBL);
  }

  function positionRoadLayers() {
    if (!map.getLayer('buildings-live')) return;
    if (roadLayersArePositioned()) return;
    const before = 'buildings-live';
    for (const id of ROAD_LAYER_IDS) {
      if (map.getLayer(id)) map.moveLayer(id, before);
    }
  }

  let roadPosScheduled = false;
  function schedulePositionRoadLayers() {
    if (roadPosScheduled) return;
    roadPosScheduled = true;
    requestAnimationFrame(() => { roadPosScheduled = false; positionRoadLayers(); });
  }

  function updateRoadDrawButton({ roadDrawActive, draftCoords, drawnRoads }) {
    const btn = document.getElementById('road-draw-btn');
    if (!btn) return;
    if (roadDrawActive) btn.textContent = `✅ Finish road (${draftCoords.length})`;
    else btn.textContent = drawnRoads.size ? `🛣️ Draw road (${drawnRoads.size})` : '🛣️ Draw road';
    btn.classList.toggle('active', roadDrawActive);
  }

  function updateRoadDeleteButton({ roadDeleteActive, drawnRoads }) {
    const btn = document.getElementById('road-delete-btn');
    if (!btn) return;
    if (roadDeleteActive) btn.textContent = `🗑️ Stop deleting (${drawnRoads.size})`;
    else btn.textContent = drawnRoads.size ? `🗑️ Delete road (${drawnRoads.size})` : '🗑️ Delete road';
    btn.classList.toggle('active', roadDeleteActive);
  }

  return {
    ROAD_LAYER_IDS,
    createRoadLayers,
    roadLayersArePositioned,
    positionRoadLayers,
    schedulePositionRoadLayers,
    updateRoadDrawButton,
    updateRoadDeleteButton
  };
}

export function createRoadLifecycleController({
  map,
  dbg,
  getRoadDrawActive,
  setRoadDrawActive,
  getRoadDeleteActive,
  setRoadDeleteActive,
  getDraftCoords,
  setDraftCoords,
  getDraftCursor,
  setDraftCursor,
  getDrawnRoads,
  setDrawnRoads,
  getHoveredDeleteRoadId,
  setHoveredDeleteRoadId,
  getRoadIdCounter,
  setRoadIdCounter,
  getRoadDrawColor,
  setRoadDrawColor,
  getRoadDrawWidth,
  setRoadDrawWidth,
  createRoadLayers,
  positionRoadLayers,
  refreshDrawnRoads,
  setDraftData,
  clearDeleteHover,
  updateRoadDrawButton,
  updateRoadDeleteButton,
  getTilePickerActive,
  setTilePickerActive,
  getBuildingDrawActive,
  cancelBuilding,
  getBuildingEditActive,
  stopBuildingEdit,
  getBuildingDeleteActive,
  setBuildingDeleteActive,
  getZoneDrawActive,
  cancelZone,
  getZoneDeleteActive,
  setZoneDeleteActive,
  logPrompt,
  resolveColor
}) {
  function setRoadDrawState(active) {
    if (active) {
      if (getTilePickerActive()) setTilePickerActive(false);
      if (getRoadDeleteActive()) setRoadDeleteActive(false);
      if (getBuildingDrawActive()) cancelBuilding();
      if (getBuildingEditActive()) stopBuildingEdit();
      if (getBuildingDeleteActive()) setBuildingDeleteActive(false);
      if (getZoneDrawActive()) cancelZone();
      if (getZoneDeleteActive()) setZoneDeleteActive(false);
    }
    setRoadDrawActive(active);
    if (active) {
      if (!map.getLayer('drawn-roads')) createRoadLayers();
      else positionRoadLayers();
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
    } else {
      map.doubleClickZoom.enable();
      if (!getRoadDeleteActive()) map.getCanvas().style.cursor = '';
      setDraftCursor(null);
    }
    updateRoadDrawButton({ roadDrawActive: getRoadDrawActive(), draftCoords: getDraftCoords(), drawnRoads: getDrawnRoads() });
    setDraftData();
  }

  function setRoadDeleteState(active) {
    if (active) {
      if (getTilePickerActive()) setTilePickerActive(false);
      if (getRoadDrawActive()) setRoadDrawState(false);
      if (getBuildingDrawActive()) cancelBuilding();
      if (getBuildingEditActive()) stopBuildingEdit();
      if (getBuildingDeleteActive()) setBuildingDeleteActive(false);
      if (getZoneDrawActive()) cancelZone();
      if (getZoneDeleteActive()) setZoneDeleteActive(false);
    }
    setRoadDeleteActive(active);
    if (active) {
      if (!map.getLayer('drawn-roads')) createRoadLayers();
      else positionRoadLayers();
      map.getCanvas().style.cursor = 'crosshair';
      if (!getDrawnRoads().size) logPrompt('info', 'No drawn roads to delete yet.');
    } else {
      clearDeleteHover();
      map.getCanvas().style.cursor = '';
    }
    updateRoadDeleteButton({ roadDeleteActive: getRoadDeleteActive(), drawnRoads: getDrawnRoads() });
  }

  function startRoadDrawing() {
    if (getRoadDrawActive()) return logPrompt('info', 'Already drawing.');
    setDraftCoords([]);
    setDraftCursor(null);
    setRoadDrawState(true);
    logPrompt('bot', `Road drawing ON — color ${getRoadDrawColor()}, width ${getRoadDrawWidth()} m.`);
  }

  function startRoadDeleting() {
    if (getRoadDeleteActive()) { setRoadDeleteState(false); return logPrompt('info', 'Road deletion OFF.'); }
    setRoadDeleteState(true);
    logPrompt('bot', 'Road deletion ON — hover a road and click to delete it.');
  }

  function finishRoad() {
    if (!getRoadDrawActive()) return logPrompt('info', 'Not drawing.');
    if (getDraftCoords().length < 2) {
      logPrompt('error', 'A road needs at least 2 points — cancelled.');
      return cancelRoad();
    }
    const nextIdNumber = getRoadIdCounter() + 1;
    setRoadIdCounter(nextIdNumber);
    const id = `road-${nextIdNumber}`;
    const n = getDraftCoords().length;
    const roads = getDrawnRoads();
    roads.set(id, { id, coords: getDraftCoords().slice(), color: '#ff0000', width: getRoadDrawWidth() });
    setDrawnRoads(roads);
    setDraftCoords([]);
    setDraftCursor(null);
    setRoadDrawState(false);
    refreshDrawnRoads();
    setDraftData();
    positionRoadLayers();
    logPrompt('bot', `Added ${id} (${n} points).`);
  }

  function cancelRoad() {
    if (!getRoadDrawActive() && !getDraftCoords().length) return logPrompt('info', 'Not drawing.');
    setDraftCoords([]);
    setDraftCursor(null);
    setRoadDrawState(false);
    setDraftData();
    logPrompt('bot', 'Road drawing cancelled.');
  }

  function addDraftPoint(lon, lat) {
    const coords = getDraftCoords();
    coords.push([lon, lat]);
    setDraftCoords(coords);
    setDraftCursor([lon, lat]);
    setDraftData();
  }

  function undoDraftPoint() {
    if (!getRoadDrawActive()) return logPrompt('info', 'Not drawing.');
    const coords = getDraftCoords();
    if (!coords.length) return logPrompt('info', 'No points to undo.');
    coords.pop();
    setDraftCoords(coords);
    setDraftData();
    logPrompt('info', `Point removed — ${coords.length} left.`);
  }

  function clearAllRoads() {
    if (!getDrawnRoads().size) return logPrompt('info', 'No drawn roads.');
    const n = getDrawnRoads().size;
    getDrawnRoads().clear();
    clearDeleteHover();
    refreshDrawnRoads();
    logPrompt('bot', `${n} drawn road(s) removed.`);
  }

  function listRoads() {
    if (!getDrawnRoads().size) return logPrompt('info', 'No drawn roads yet.');
    logPrompt('info', `Drawn roads: ${getDrawnRoads().size}`);
    for (const r of getDrawnRoads().values()) {
      const [lon, lat] = r.coords[0];
      logPrompt('info', `  ${r.id}  ${r.coords.length} pts  ${r.color}  w=${r.width}m  start ${lat.toFixed(5)},${lon.toFixed(5)}`);
    }
  }

  function deleteRoadById(id) {
    if (!getDrawnRoads().has(id)) return false;
    getDrawnRoads().delete(id);
    if (getHoveredDeleteRoadId() === id) clearDeleteHover();
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
      if (id && getDrawnRoads().has(id)) return getDrawnRoads().get(id);
    }
    return null;
  }

  function setDeleteHover(road) {
    if (!road) { clearDeleteHover(); return; }
    setHoveredDeleteRoadId(road.id);
    const src = map.getSource('road-delete-hover-src');
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: road.coords } }]
    });
  }

  function clearDeleteHover() {
    setHoveredDeleteRoadId(null);
    const src = map.getSource('road-delete-hover-src');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function setRoadColor(name) {
    const c = resolveColor(name);
    if (!c) return logPrompt('error', `Unknown color: "${name}"`);
    setRoadDrawColor(c);
    logPrompt('bot', `Draft colour set to ${c}.`);
  }

  function setRoadWidth(n) {
    const v = Math.max(0.5, Math.min(60, n));
    setRoadDrawWidth(v);
    logPrompt('bot', `Road width set to ${v} m.`);
  }

  function setDraftData() {
    const lineSrc = map.getSource('road-draft-src');
    if (lineSrc) {
      const coords = getDraftCoords().slice();
      if (getRoadDrawActive() && getDraftCursor() && coords.length) coords.push(getDraftCursor());
      lineSrc.setData({
        type: 'FeatureCollection',
        features: coords.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : []
      });
    }
    const ptSrc = map.getSource('road-draft-points-src');
    if (ptSrc) {
      ptSrc.setData({
        type: 'FeatureCollection',
        features: getDraftCoords().map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
      });
    }
    updateRoadDrawButton({ roadDrawActive: getRoadDrawActive(), draftCoords: getDraftCoords(), drawnRoads: getDrawnRoads() });
  }

  return {
    setRoadDrawState,
    setRoadDeleteState,
    startRoadDrawing,
    startRoadDeleting,
    finishRoad,
    cancelRoad,
    addDraftPoint,
    undoDraftPoint,
    clearAllRoads,
    listRoads,
    deleteRoadById,
    findRoadAtPoint,
    setDeleteHover,
    clearDeleteHover,
    setRoadColor,
    setRoadWidth,
    setDraftData
  };
}
