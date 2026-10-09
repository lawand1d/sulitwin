export function createMapOverlayHelpers({
  map,
  dbg,
  tileBounds,
  lngLatToTile,
  center,
  fadeOuterMeters,
  logPrompt
}) {
  function addSmoothFade() {
    const SIZE = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
    grad.addColorStop(0.00, 'rgba(0,0,0,0.00)');
    grad.addColorStop(0.30, 'rgba(0,0,0,0.00)');
    grad.addColorStop(0.38, 'rgba(0,0,0,0.03)');
    grad.addColorStop(0.46, 'rgba(0,0,0,0.09)');
    grad.addColorStop(0.54, 'rgba(0,0,0,0.18)');
    grad.addColorStop(0.62, 'rgba(0,0,0,0.32)');
    grad.addColorStop(0.70, 'rgba(0,0,0,0.48)');
    grad.addColorStop(0.78, 'rgba(0,0,0,0.64)');
    grad.addColorStop(0.86, 'rgba(0,0,0,0.80)');
    grad.addColorStop(0.94, 'rgba(0,0,0,0.94)');
    grad.addColorStop(1.00, 'rgba(0,0,0,1.00)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, SIZE, SIZE);
    const cosLat = Math.cos(center[1] * Math.PI / 180);
    const dLat = fadeOuterMeters / 111320;
    const dLon = fadeOuterMeters / (111320 * cosLat);
    map.addSource('fade-image', {
      type: 'image', url: canvas.toDataURL('image/png'),
      coordinates: [
        [center[0] - dLon, center[1] + dLat],
        [center[0] + dLon, center[1] + dLat],
        [center[0] + dLon, center[1] - dLat],
        [center[0] - dLon, center[1] - dLat]
      ]
    });
    map.addLayer({
      id: 'fade-image', type: 'raster', source: 'fade-image',
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
    });
    dbg('Smooth fade image added.');
  }

  function addBlackVoid() {
    const cosLat = Math.cos(center[1] * Math.PI / 180);
    const steps = 256;
    const holePts = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      holePts.push([
        center[0] + (fadeOuterMeters * Math.cos(a)) / (111320 * cosLat),
        center[1] + (fadeOuterMeters * Math.sin(a)) / 111320
      ]);
    }
    const outer = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
    map.addSource('black-void', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [outer, holePts] } }
    });
    map.addLayer({
      id: 'black-void', type: 'fill', source: 'black-void',
      paint: { 'fill-color': '#000000', 'fill-opacity': 1, 'fill-antialias': false }
    });
    dbg('Black void added.');
  }

  function rebuildHiddenTileCovers(hiddenTiles) {
    const features = [];
    for (const { z, x, y } of hiddenTiles.values()) {
      const [w, s, e, n] = tileBounds(z, x, y);
      features.push({
        type: 'Feature',
        properties: { tile: `${z}/${x}/${y}` },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
      });
    }
    const data = { type: 'FeatureCollection', features };
    if (map.getSource('hidden-tiles-src')) {
      map.getSource('hidden-tiles-src').setData(data);
    } else {
      map.addSource('hidden-tiles-src', { type: 'geojson', data });
    }
    if (!map.getLayer('hidden-tiles')) {
      const beforeId = map.getLayer('fade-image') ? 'fade-image' : undefined;
      map.addLayer({
        id: 'hidden-tiles',
        type: 'fill',
        source: 'hidden-tiles-src',
        paint: { 'fill-color': '#0b1220', 'fill-opacity': 1, 'fill-antialias': false }
      }, beforeId);
    }
    const badge = document.getElementById('tile-picker-count');
    if (badge) badge.textContent = hiddenTiles.size ? ` (${hiddenTiles.size})` : '';
    dbg(`Hidden tiles: ${hiddenTiles.size}.`);
  }

  function ensureTileHoverLayer() {
    if (map.getLayer('tile-hover')) return;
    map.addSource('tile-hover-src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'tile-hover',
      type: 'line',
      source: 'tile-hover-src',
      paint: {
        'line-color': '#22c55e',
        'line-width': 2,
        'line-dasharray': [4, 3],
        'line-opacity': 0.9
      }
    });
  }

  function updateTileHover({ lon, lat, tilePickerActive, hiddenTiles }) {
    if (!tilePickerActive) return;
    ensureTileHoverLayer();
    const z = Math.round(map.getZoom());
    const { x, y } = lngLatToTile(lon, lat, z);
    const [w, s, e, n] = tileBounds(z, x, y);
    const isHidden = hiddenTiles.has(`${z}/${x}/${y}`);
    map.getSource('tile-hover-src').setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
      }]
    });
    map.setPaintProperty('tile-hover', 'line-color', isHidden ? '#ef4444' : '#22c55e');
  }

  function clearTileHover() {
    if (map.getLayer('tile-hover') && map.getSource('tile-hover-src')) {
      map.getSource('tile-hover-src').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  function toggleTileAt({ lon, lat, hiddenTiles }) {
    const z = Math.round(map.getZoom());
    const { x, y } = lngLatToTile(lon, lat, z);
    const key = `${z}/${x}/${y}`;
    if (hiddenTiles.has(key)) {
      hiddenTiles.delete(key);
      logPrompt('bot', `Restored tile ${key}.`);
    } else {
      hiddenTiles.set(key, { z, x, y });
      logPrompt('bot', `Hidden tile ${key}.`);
    }
    return hiddenTiles;
  }

  return {
    addSmoothFade,
    addBlackVoid,
    rebuildHiddenTileCovers,
    ensureTileHoverLayer,
    updateTileHover,
    clearTileHover,
    toggleTileAt
  };
}
