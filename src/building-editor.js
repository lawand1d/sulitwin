export function createBuildingEditorController({ map, dbg }) {
  const BUILDING_OVERLAY_LAYER_IDS = [
    'building-vertices', 'building-selected', 'building-draft-points',
    'building-draft-line', 'building-draft-fill',
    'building-delete-hover-outline', 'building-delete-hover-fill'
  ];

  function createBuildingEditorLayers({ buildingDefaultColor = '#7ef29d' } = {}) {
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

  return {
    BUILDING_OVERLAY_LAYER_IDS,
    createBuildingEditorLayers,
    createBuildingDeleteLayers,
    bringBuildingEditorToTop,
    scheduleBringBuildingEditorToTop
  };
}

export function createBuildingSelectionController({
  map,
  customBuildings,
  hiddenBuildingKeys,
  buildingKey,
  getSelectedBuildingId,
  setSelectedBuildingId,
  updateBuildingEditButton,
  logPrompt
}) {
  function updateSelectionOverlay() {
    const selectedId = getSelectedBuildingId();
    const selected = selectedId ? customBuildings.get(selectedId) : null;
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
    const key = buildingKey ? buildingKey(h) : null;
    if (key && !hiddenBuildingKeys.has(key)) return { kind: 'osm', key, geometry: h.geometry };
    return null;
  }

  function setBuildingDeleteHover(entry) {
    if (!entry) { clearBuildingDeleteHover(); return; }
    const src = map.getSource('building-delete-hover-src');
    if (!src) return;
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: entry.geometry }] });
  }

  function clearBuildingDeleteHover() {
    const src = map.getSource('building-delete-hover-src');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function selectBuilding(id) {
    setSelectedBuildingId(id);
    updateSelectionOverlay();
    updateBuildingEditButton();
    const b = customBuildings.get(id);
    if (b && logPrompt) logPrompt('info', `Selected ${id} (${b.height} m, ${b.color}).`);
  }

  function deselectBuilding() {
    setSelectedBuildingId(null);
    updateSelectionOverlay();
    updateBuildingEditButton();
  }

  return {
    updateSelectionOverlay,
    findBuildingAtPoint,
    setBuildingDeleteHover,
    clearBuildingDeleteHover,
    selectBuilding,
    deselectBuilding
  };
}

export function createBuildingInteractionController({
  map,
  customBuildings,
  getSelectedBuildingId,
  setSelectedBuildingId,
  updateSelectionOverlay,
  getBuildingDragState,
  setBuildingDragState,
  saveCustomBuildings,
  logPrompt
}) {
  function tryStartBuildingDrag(e, context = {}) {
    const buildingEditActive = context.buildingEditActive;
    const selectedBuildingId = context.selectedBuildingId ?? getSelectedBuildingId();
    const selected = selectedBuildingId ? customBuildings.get(selectedBuildingId) : null;
    if (!buildingEditActive || !selectedBuildingId || !selected) return false;
    if (map.getLayer('building-vertices')) {
      let vHits = [];
      try { vHits = map.queryRenderedFeatures(e.point, { layers: ['building-vertices'] }); }
      catch (_) { vHits = []; }
      if (vHits.length) {
        const idx = vHits[0].properties.index;
        if (Number.isInteger(idx) && idx >= 0 && idx < selected.coords.length) {
          setBuildingDragState({
            type: 'vertex', id: selectedBuildingId, index: idx,
            startCoords: selected.coords.map(c => [...c])
          });
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
        setBuildingDragState({
          type: 'body', id: selectedBuildingId,
          startLngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          startCoords: selected.coords.map(c => [...c])
        });
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'grabbing';
        return true;
      }
    }
    return false;
  }

  function updateBuildingDrag(e) {
    const state = getBuildingDragState();
    if (!state) return;
    const b = customBuildings.get(state.id);
    if (!b) { setBuildingDragState(null); return; }
    if (state.type === 'vertex') {
      b.coords[state.index] = [e.lngLat.lng, e.lngLat.lat];
    } else if (state.type === 'body') {
      const dLng = e.lngLat.lng - state.startLngLat.lng;
      const dLat = e.lngLat.lat - state.startLngLat.lat;
      b.coords = state.startCoords.map(([lon, lat]) => [lon + dLng, lat + dLat]);
    }
    updateSelectionOverlay();
  }

  function endBuildingDrag() {
    const state = getBuildingDragState();
    if (!state) return;
    setBuildingDragState(null);
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
    if (saveCustomBuildings) saveCustomBuildings();
    if (logPrompt) logPrompt('info', 'Building position updated.');
  }

  return {
    getBuildingDragState,
    setBuildingDragState,
    tryStartBuildingDrag,
    updateBuildingDrag,
    endBuildingDrag
  };
}

export function createBuildingLifecycleController({
  map,
  customBuildings,
  getBuildingIdCounter,
  setBuildingIdCounter,
  getBuildingDraftCoords,
  setBuildingDraftCoords,
  getBuildingDraftCursor,
  setBuildingDraftCursor,
  getPendingBuilding,
  setPendingBuilding,
  getBuildingDrawActive,
  setBuildingDrawActive,
  getBuildingEditActive,
  setBuildingEditActive,
  getBuildingDeleteActive,
  setBuildingDeleteActive,
  getSelectedBuildingId,
  setSelectedBuildingId,
  getBuildingDefaultHeight,
  setBuildingDefaultHeight,
  getBuildingDefaultColor,
  setBuildingDefaultColor,
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
  setTilePickerActive,
  cancelRoad,
  setRoadDeleteActive,
  cancelZone,
  setZoneDeleteActive,
  setZoneDrawActive,
  tilePickerActive,
  roadDrawActive,
  roadDeleteActive,
  zoneDrawActive,
  zoneDeleteActive,
  cancelBuilding,
  stopBuildingEdit,
  setBuildingDeleteActiveState,
  updateBuildingDraftData,
  animateNewBuilding
}) {
  function setBuildingDraftData() {
    const fillSrc = map.getSource('building-draft-fill-src');
    if (fillSrc) {
      const closed = getBuildingDraftCoords().length >= 3 ? [[...getBuildingDraftCoords(), getBuildingDraftCoords()[0]]] : [];
      fillSrc.setData({
        type: 'FeatureCollection',
        features: closed.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: closed } }] : []
      });
    }
    const lineSrc = map.getSource('building-draft-line-src');
    if (lineSrc) {
      const coords = getBuildingDraftCoords().slice();
      if (getBuildingDrawActive() && !getPendingBuilding() && getBuildingDraftCursor() && coords.length) coords.push(getBuildingDraftCursor());
      if (getBuildingDrawActive() && coords.length >= 3) coords.push(coords[0]);
      lineSrc.setData({
        type: 'FeatureCollection',
        features: coords.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : []
      });
    }
    const ptSrc = map.getSource('building-draft-points-src');
    if (ptSrc) {
      ptSrc.setData({
        type: 'FeatureCollection',
        features: getBuildingDraftCoords().map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
      });
    }
    if (typeof updateBuildingBuildButton === 'function') updateBuildingBuildButton();
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
    if (!input) return getBuildingDefaultHeight();
    const v = parseFloat(input.value);
    if (!Number.isFinite(v) || v <= 0) return getBuildingDefaultHeight();
    return Math.min(500, Math.max(1, v));
  }

  function commitPendingBuilding() {
    const pending = getPendingBuilding();
    if (!pending) return false;
    const n = pending.coords.length;
    const height = readHeightInput();
    const nextIdNumber = getBuildingIdCounter() + 1;
    setBuildingIdCounter(nextIdNumber);
    const id = `custom-${nextIdNumber}`;
    const building = {
      id, coords: pending.coords, height, base: 0, color: getBuildingDefaultColor()
    };
    customBuildings.set(id, building);
    if (typeof animateNewBuilding === 'function') animateNewBuilding(building);
    setPendingBuilding(null);
    setBuildingDraftCoords([]);
    setBuildingDraftCursor(null);
    hideHeightPanel();
    setBuildingDrawActive(false);
    refreshBuildings();
    if (state.buildingLabels) updateBuildingLabels();
    saveCustomBuildings();
    setBuildingDefaultHeight(height);
    logPrompt('bot', `Added building ${id} (${n} vertices, ${height} m).`);
    setSelectedBuildingId(id);
    updateSelectionOverlay();
    if (typeof updateBuildingEditButton === 'function') updateBuildingEditButton();
    return true;
  }

  function cancelPendingBuilding() {
    if (!getPendingBuilding()) return false;
    setPendingBuilding(null);
    setBuildingDraftCoords([]);
    setBuildingDraftCursor(null);
    hideHeightPanel();
    setBuildingDrawActive(false);
    logPrompt('bot', 'Building creation cancelled.');
    return true;
  }

  function startBuildingDrawing() {
    if (getPendingBuilding()) { focusHeightInput(); return; }
    if (getBuildingDrawActive()) return logPrompt('info', 'Already drawing.');
    setBuildingDraftCoords([]);
    setBuildingDraftCursor(null);
    setBuildingDrawActive(true);
    logPrompt('bot', `Building drawing ON — default ${getBuildingDefaultHeight()} m.`);
    logPrompt('info', 'Click map to add vertices · Enter/first-vertex to finish · Esc cancel.');
  }

  function startBuildingDeleting() {
    if (getBuildingDeleteActive()) { setBuildingDeleteActive(false); return logPrompt('info', 'Building deletion OFF.'); }
    setBuildingDeleteActive(true);
    logPrompt('bot', 'Building deletion ON.');
  }

  function addBuildingVertex(lon, lat) {
    const coords = getBuildingDraftCoords();
    if (coords.length) {
      const [lastLon, lastLat] = coords[coords.length - 1];
      const d = Math.hypot(lon - lastLon, lat - lastLat);
      if (d < 1e-6) return;
    }
    coords.push([lon, lat]);
    setBuildingDraftCoords(coords);
    setBuildingDraftCursor([lon, lat]);
    setBuildingDraftData();
  }

  function undoBuildingVertex() {
    if (!getBuildingDrawActive()) return logPrompt('info', 'Not building.');
    const coords = getBuildingDraftCoords();
    if (!coords.length) return logPrompt('info', 'No vertices to undo.');
    coords.pop();
    setBuildingDraftCoords(coords);
    setBuildingDraftData();
    logPrompt('info', `Vertex removed — ${coords.length} left.`);
  }

  function finishBuilding() {
    if (!getBuildingDrawActive()) return logPrompt('info', 'Not building.');
    if (getPendingBuilding()) { focusHeightInput(); return; }
    if (getBuildingDraftCoords().length < 3) {
      logPrompt('error', 'A building needs at least 3 vertices — cancelled.');
      return cancelBuilding();
    }
    setPendingBuilding({ coords: getBuildingDraftCoords().slice() });
    setBuildingDraftCursor(null);
    showHeightPanel(getBuildingDefaultHeight());
    setBuildingDraftData();
  }

  function cancelBuilding() {
    if (getPendingBuilding()) return cancelPendingBuilding();
    if (!getBuildingDrawActive() && !getBuildingDraftCoords().length) return logPrompt('info', 'Not building.');
    setBuildingDraftCoords([]);
    setBuildingDraftCursor(null);
    setBuildingDrawActive(false);
    setBuildingDraftData();
    logPrompt('bot', 'Building drawing cancelled.');
  }

  function startBuildingEdit() {
    if (getBuildingEditActive()) return logPrompt('info', 'Already editing.');
    if (getPendingBuilding()) cancelPendingBuilding();
    if (tilePickerActive) setTilePickerActive(false);
    if (roadDrawActive) cancelRoad();
    if (roadDeleteActive) setRoadDeleteActive(false);
    if (getBuildingDrawActive()) cancelBuilding();
    if (getBuildingDeleteActive()) setBuildingDeleteActive(false);
    if (zoneDrawActive) cancelZone();
    if (zoneDeleteActive) setZoneDeleteActive(false);
    setBuildingEditActive(true);
    createBuildingEditorLayers();
    if (typeof updateBuildingEditButton === 'function') updateBuildingEditButton();
    logPrompt('bot', 'Building edit ON.');
  }

  function stopBuildingEdit() {
    if (!getBuildingEditActive()) return logPrompt('info', 'Not editing.');
    setBuildingEditActive(false);
    setSelectedBuildingId(null);
    updateSelectionOverlay();
    if (typeof updateBuildingEditButton === 'function') updateBuildingEditButton();
    map.getCanvas().style.cursor = '';
    saveCustomBuildings();
    logPrompt('bot', 'Building edit OFF.');
  }

  function deleteSelectedBuilding() {
    const id = getSelectedBuildingId();
    if (!id) return logPrompt('info', 'No building selected.');
    if (!customBuildings.has(id)) return logPrompt('error', 'Selected building no longer exists.');
    customBuildings.delete(id);
    setSelectedBuildingId(null);
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
    setSelectedBuildingId(null);
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
    if (getPendingBuilding()) {
      const input = document.getElementById('height-input');
      if (input) input.value = String(v);
      return logPrompt('bot', `Height prompt updated to ${v} m.`);
    }
    const selectedId = getSelectedBuildingId();
    if (selectedId && customBuildings.has(selectedId)) {
      customBuildings.get(selectedId).height = v;
      refreshBuildings();
      saveCustomBuildings();
      logPrompt('bot', `Height of ${selectedId} set to ${v} m.`);
    } else {
      setBuildingDefaultHeight(v);
      logPrompt('bot', `Default height for new buildings set to ${v} m.`);
    }
  }

  function setBuildingColor(name) {
    const c = resolveColor(name);
    if (!c) return logPrompt('error', `Unknown color: "${name}"`);
    const selectedId = getSelectedBuildingId();
    if (selectedId && customBuildings.has(selectedId)) {
      customBuildings.get(selectedId).color = c;
      refreshBuildings();
      saveCustomBuildings();
      logPrompt('bot', `Color of ${selectedId} set to ${c}.`);
    } else {
      setBuildingDefaultColor(c);
      if (map.getLayer('building-draft-fill')) map.setPaintProperty('building-draft-fill', 'fill-color', c);
      logPrompt('bot', `Default color for new buildings set to ${c}.`);
    }
  }

  return {
    setBuildingDraftData,
    showHeightPanel,
    hideHeightPanel,
    focusHeightInput,
    readHeightInput,
    commitPendingBuilding,
    cancelPendingBuilding,
    startBuildingDrawing,
    startBuildingDeleting,
    addBuildingVertex,
    undoBuildingVertex,
    finishBuilding,
    cancelBuilding,
    startBuildingEdit,
    stopBuildingEdit,
    deleteSelectedBuilding,
    clearAllCustomBuildings,
    listCustomBuildings,
    setBuildingHeight,
    setBuildingColor
  };
}
