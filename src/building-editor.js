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
