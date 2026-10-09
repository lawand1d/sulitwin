export function createZoneController({
  map,
  dbg,
  detectFontStack,
  haversineMeters,
  zoneCircleCoords,
  ZONE_CLASSES,
  getZones,
  getZoneIdCounter,
  setZoneIdCounter,
  getZoneDrawActive,
  setZoneDrawActive,
  getZoneDraftCenter,
  setZoneDraftCenter,
  getZoneDraftRadiusM,
  setZoneDraftRadiusM,
  getZoneDeleteActive,
  setZoneDeleteActive,
  getHoveredDeleteZoneId,
  setHoveredDeleteZoneId,
  getPendingZone,
  setPendingZone,
  getZoneDefaultClass,
  setZoneDefaultClass,
  saveZones,
  loadZones,
  zoneStorageKey = 'maplibre-custom-zones-v1'
}) {
  const ZONE_TOP_LAYER_IDS = ['zone-labels', 'zone-draft-outline', 'zone-draft-fill', 'zone-delete-hover-outline', 'zone-delete-hover-fill'];

  function createZoneLayers() {
    if (!map.getSource('zones-src')) {
      map.addSource('zones-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('zone-labels-src')) {
      map.addSource('zone-labels-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('zone-draft-src')) {
      map.addSource('zone-draft-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('zone-delete-hover-src')) {
      map.addSource('zone-delete-hover-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }

    const colorExpr = ['match', ['get', 'class'], 'Flood', '#2563eb', 'Green', '#16a34a', 'Shade', '#6b7280', '#888888'];
    const before = map.getLayer('buildings-shadow') ? 'buildings-shadow' : (map.getLayer('buildings-live') ? 'buildings-live' : undefined);

    if (!map.getLayer('zones-fill')) {
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones-src', paint: { 'fill-color': colorExpr, 'fill-opacity': 0.4 } }, before);
    }
    if (!map.getLayer('zones-outline')) {
      map.addLayer({ id: 'zones-outline', type: 'line', source: 'zones-src', paint: { 'line-color': colorExpr, 'line-opacity': 1.0, 'line-width': 3 } }, before);
    }
    if (!map.getLayer('zone-draft-fill')) {
      map.addLayer({ id: 'zone-draft-fill', type: 'fill', source: 'zone-draft-src', paint: { 'fill-color': ['match', ['get', 'class'], 'Flood', '#2563eb', 'Green', '#16a34a', 'Shade', '#6b7280', '#0ea5e9'], 'fill-opacity': 0.4 } });
    }
    if (!map.getLayer('zone-draft-outline')) {
      map.addLayer({ id: 'zone-draft-outline', type: 'line', source: 'zone-draft-src', paint: { 'line-color': ['match', ['get', 'class'], 'Flood', '#2563eb', 'Green', '#16a34a', 'Shade', '#6b7280', '#0ea5e9'], 'line-opacity': 1.0, 'line-width': 2.5, 'line-dasharray': [3, 2] } });
    }
    if (!map.getLayer('zone-delete-hover-fill')) {
      map.addLayer({ id: 'zone-delete-hover-fill', type: 'fill', source: 'zone-delete-hover-src', paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.5 } });
    }
    if (!map.getLayer('zone-delete-hover-outline')) {
      map.addLayer({ id: 'zone-delete-hover-outline', type: 'line', source: 'zone-delete-hover-src', paint: { 'line-color': '#ef4444', 'line-width': 3, 'line-opacity': 1 } });
    }
    if (!map.getLayer('zone-labels')) {
      const fontStack = detectFontStack();
      map.addLayer({
        id: 'zone-labels',
        type: 'symbol',
        source: 'zone-labels-src',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': fontStack,
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 12, 18, 16, 19, 20],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-rotation-alignment': 'viewport',
          'text-pitch-alignment': 'viewport'
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
    requestAnimationFrame(() => {
      zoneTopPosScheduled = false;
      bringZoneTopLayersToTop();
    });
  }

  function refreshZones() {
    const features = [];
    const labelFeatures = [];
    for (const zone of getZones().values()) {
      const coords = zoneCircleCoords(zone.center, zone.radiusMeters, 64);
      features.push({
        type: 'Feature',
        properties: { id: zone.id, class: zone.class },
        geometry: { type: 'Polygon', coordinates: [coords] }
      });
      labelFeatures.push({
        type: 'Feature',
        properties: { id: zone.id, label: zone.id },
        geometry: { type: 'Point', coordinates: zone.center }
      });
    }

    const src = map.getSource('zones-src');
    if (src) src.setData({ type: 'FeatureCollection', features });
    const labelSrc = map.getSource('zone-labels-src');
    if (labelSrc) labelSrc.setData({ type: 'FeatureCollection', features: labelFeatures });
  }

  function updateZoneDraftPreview() {
    const src = map.getSource('zone-draft-src');
    if (!src) return;
    if (!getZoneDrawActive() || !getZoneDraftCenter()) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const radius = getZoneDraftRadiusM() > 0 ? getZoneDraftRadiusM() : 1;
    const coords = zoneCircleCoords(getZoneDraftCenter(), radius, 64);
    src.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { class: getZoneDefaultClass() },
        geometry: { type: 'Polygon', coordinates: [coords] }
      }]
    });
  }

  function setZoneDeleteHover(zone) {
    if (!zone) {
      clearZoneDeleteHover();
      return;
    }
    setHoveredDeleteZoneId(zone.id);
    const src = map.getSource('zone-delete-hover-src');
    if (!src) return;
    const coords = zoneCircleCoords(zone.center, zone.radiusMeters, 64);
    src.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [coords] }
      }]
    });
  }

  function clearZoneDeleteHover() {
    setHoveredDeleteZoneId(null);
    const src = map.getSource('zone-delete-hover-src');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function findZoneAtPoint(point) {
    if (!map.getLayer('zones-fill')) return null;
    let hits;
    try {
      hits = map.queryRenderedFeatures(point, { layers: ['zones-fill'] });
    } catch (e) {
      return null;
    }
    if (!hits || !hits.length) return null;
    for (const hit of hits) {
      const id = hit.properties && hit.properties.id;
      if (id && getZones().has(id)) return getZones().get(id);
    }
    return null;
  }

  function updateZoneDrawButton() {
    const btn = document.getElementById('zone-draw-btn');
    if (!btn) return;
    if (getPendingZone()) {
      btn.textContent = '⏳ Choose class…';
      btn.classList.add('active');
      return;
    }
    if (getZoneDrawActive()) btn.textContent = getZoneDraftCenter() ? '✅ Set radius' : '⭕ Click center';
    else btn.textContent = getZones().size ? `⭕ Draw zone (${getZones().size})` : '⭕ Draw zone';
    btn.classList.toggle('active', getZoneDrawActive());
  }

  function updateZoneDeleteButton() {
    const btn = document.getElementById('zone-delete-btn');
    if (!btn) return;
    if (getZoneDeleteActive()) {
      btn.textContent = getZones().size ? `🗑️ Stop deleting (${getZones().size})` : '🗑️ Stop deleting';
    } else {
      btn.textContent = getZones().size ? `🗑️ Delete zone (${getZones().size})` : '🗑️ Delete zone';
    }
    btn.classList.toggle('active', getZoneDeleteActive());
  }

  function applyZoneDrawState(active) {
    setZoneDrawActive(active);
    if (active) {
      createZoneLayers();
      map.getCanvas().style.cursor = 'crosshair';
    } else {
      map.getCanvas().style.cursor = '';
      setZoneDraftCenter(null);
      setZoneDraftRadiusM(0);
      updateZoneDraftPreview();
    }
    updateZoneDrawButton();
  }

  function applyZoneDeleteState(active) {
    setZoneDeleteActive(active);
    if (active) {
      createZoneLayers();
      map.getCanvas().style.cursor = 'crosshair';
    } else {
      clearZoneDeleteHover();
      map.getCanvas().style.cursor = '';
    }
    updateZoneDeleteButton();
  }

  function startZoneDrawing() {
    if (getPendingZone()) return;
    if (getZoneDrawActive()) return;
    setZoneDraftCenter(null);
    setZoneDraftRadiusM(0);
    applyZoneDrawState(true);
  }

  function startZoneDeleting() {
    if (getZoneDeleteActive()) {
      applyZoneDeleteState(false);
      return;
    }
    applyZoneDeleteState(true);
  }

  function cancelZone() {
    if (getPendingZone()) return;
    if (!getZoneDrawActive() && !getZoneDraftCenter()) return;
    setZoneDraftCenter(null);
    setZoneDraftRadiusM(0);
    applyZoneDrawState(false);
    updateZoneDraftPreview();
  }

  function placeZoneCenter(lon, lat) {
    setZoneDraftCenter([lon, lat]);
    setZoneDraftRadiusM(0);
    updateZoneDraftPreview();
    updateZoneDrawButton();
  }

  function placeZoneRadius(lon, lat) {
    if (!getZoneDraftCenter()) return;
    const r = haversineMeters(getZoneDraftCenter()[0], getZoneDraftCenter()[1], lon, lat);
    if (r < 1) return;
    setZoneDraftRadiusM(r);
    updateZoneDraftPreview();
    setPendingZone({ center: getZoneDraftCenter().slice(), radiusMeters: r });
    updateZoneDrawButton();
  }

  function showZoneClassPanel() {
    const panel = document.getElementById('zone-class-panel');
    if (!panel) return;
    panel.querySelectorAll('.zone-class-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.class === getZoneDefaultClass());
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
    if (!getPendingZone()) return false;
    if (!ZONE_CLASSES[zoneClass]) return false;
    const nextIdNumber = getZoneIdCounter() + 1;
    setZoneIdCounter(nextIdNumber);
    const id = `Z${nextIdNumber}`;
    getZones().set(id, {
      id,
      center: getPendingZone().center,
      radiusMeters: getPendingZone().radiusMeters,
      class: zoneClass
    });
    setPendingZone(null);
    setZoneDraftCenter(null);
    setZoneDraftRadiusM(0);
    setZoneDefaultClass(zoneClass);
    applyZoneDrawState(false);
    refreshZones();
    saveZones();
    return true;
  }

  function cancelPendingZone() {
    if (!getPendingZone()) return;
    setPendingZone(null);
    setZoneDraftCenter(null);
    setZoneDraftRadiusM(0);
    hideZoneClassPanel();
    applyZoneDrawState(false);
    updateZoneDraftPreview();
  }

  function deleteZoneById(id) {
    if (!getZones().has(id)) return false;
    getZones().delete(id);
    if (getHoveredDeleteZoneId() === id) clearZoneDeleteHover();
    refreshZones();
    saveZones();
    return true;
  }

  function clearAllZones() {
    if (!getZones().size) return 0;
    const count = getZones().size;
    getZones().clear();
    clearZoneDeleteHover();
    refreshZones();
    saveZones();
    return count;
  }

  function listZones() {
    return getZones().size ? [...getZones().values()] : [];
  }

  function setZoneClass(id, cls) {
    if (!ZONE_CLASSES[cls]) return false;
    const zone = getZones().get(id);
    if (!zone) return false;
    zone.class = cls;
    refreshZones();
    saveZones();
    return true;
  }

  function infoAboutZone(id) {
    const zone = getZones().get(id);
    if (!zone) return null;
    const [lon, lat] = zone.center;
    const area = Math.PI * zone.radiusMeters * zone.radiusMeters;
    return { zone, lat, lon, area };
  }

  function loadZonesState() {
    try {
      const raw = localStorage.getItem(zoneStorageKey);
      if (!raw) return 0;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return 0;
      getZones().clear();
      for (const z of arr) {
        if (!z || !Array.isArray(z.center) || z.center.length !== 2) continue;
        const id = String(z.id || `Z${getZoneIdCounter() + 1}`);
        const parsedId = Number.parseInt(id.replace(/^Z/, ''), 10) || 0;
        if (parsedId > getZoneIdCounter()) setZoneIdCounter(parsedId);
        getZones().set(id, {
          id,
          center: [Number(z.center[0]), Number(z.center[1])],
          radiusMeters: Number(z.radiusMeters) || 50,
          class: ZONE_CLASSES[z.class] ? z.class : 'Flood'
        });
      }
      return getZones().size;
    } catch (e) {
      dbg('load zones failed: ' + e.message);
      return 0;
    }
  }

  function saveZonesState() {
    try {
      localStorage.setItem(zoneStorageKey, JSON.stringify([...getZones().values()]));
    } catch (e) {
      dbg('save zones failed: ' + e.message);
    }
  }

  return {
    ZONE_TOP_LAYER_IDS,
    createZoneLayers,
    bringZoneTopLayersToTop,
    scheduleBringZoneTopLayersToTop,
    refreshZones,
    updateZoneDraftPreview,
    setZoneDeleteHover,
    clearZoneDeleteHover,
    findZoneAtPoint,
    updateZoneDrawButton,
    updateZoneDeleteButton,
    setZoneDrawActive: applyZoneDrawState,
    setZoneDeleteActive: applyZoneDeleteState,
    startZoneDrawing,
    startZoneDeleting,
    cancelZone,
    placeZoneCenter,
    placeZoneRadius,
    showZoneClassPanel,
    hideZoneClassPanel,
    commitPendingZone,
    cancelPendingZone,
    deleteZoneById,
    clearAllZones,
    listZones,
    setZoneClass,
    infoAboutZone,
    saveZonesState,
    loadZonesState
  };
}
