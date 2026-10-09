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
