function offsetPoint([lon, lat], eastMeters, northMeters) {
  const metersPerLon = 111320 * Math.cos(lat * Math.PI / 180);
  return [lon + eastMeters / metersPerLon, lat + northMeters / 111320];
}

function beamPolygon(start, end, widthMeters) {
  const middleLat = (start[1] + end[1]) / 2;
  const metersPerLon = 111320 * Math.cos(middleLat * Math.PI / 180);
  const dx = (end[0] - start[0]) * metersPerLon;
  const dy = (end[1] - start[1]) * 111320;
  const length = Math.hypot(dx, dy) || 1;
  const east = -dy / length * widthMeters / 2;
  const north = dx / length * widthMeters / 2;
  const a = offsetPoint(start, east, north);
  const b = offsetPoint(end, east, north);
  const c = offsetPoint(end, -east, -north);
  const d = offsetPoint(start, -east, -north);
  return [[a, b, c, d, a]];
}

function postPolygon(center, widthMeters) {
  const half = widthMeters / 2;
  return [[
    offsetPoint(center, -half, -half),
    offsetPoint(center, half, -half),
    offsetPoint(center, half, half),
    offsetPoint(center, -half, half),
    offsetPoint(center, -half, -half)
  ]];
}

export function createBuildingConstructionController({ map, onStart, onFinish }) {
  const SOURCE_ID = 'building-construction-src';
  const BUILDING_LAYER_ID = 'building-construction-rise';
  const SCAFFOLD_LAYER_ID = 'building-construction-scaffold';
  const GLOW_LAYER_ID = 'building-construction-glow';
  const DURATION_MS = 1500;
  const RISE_FRACTION = 0.68;
  const animations = new Map();

  function ensureLayers() {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer(BUILDING_LAYER_ID)) {
      map.addLayer({
        id: BUILDING_LAYER_ID,
        type: 'fill-extrusion',
        source: SOURCE_ID,
        filter: ['==', ['get', 'part'], 'building'],
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': false
        }
      });
    }
    if (!map.getLayer(SCAFFOLD_LAYER_ID)) {
      map.addLayer({
        id: SCAFFOLD_LAYER_ID,
        type: 'fill-extrusion',
        source: SOURCE_ID,
        filter: ['==', ['get', 'part'], 'scaffold'],
        paint: {
          'fill-extrusion-color': '#f59e0b',
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'base'],
          'fill-extrusion-opacity': 0.75,
          'fill-extrusion-vertical-gradient': false
        }
      });
    }
    if (!map.getLayer(GLOW_LAYER_ID)) {
      map.addLayer({
        id: GLOW_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: ['==', ['get', 'part'], 'glow'],
        paint: {
          'line-color': '#fef08a',
          'line-width': 4,
          'line-blur': 3,
          'line-opacity': ['get', 'opacity']
        }
      });
    }
  }

  function buildFrame(building, rise, glow) {
    const ring = [...building.coords, building.coords[0]];
    const currentHeight = Math.max(0.1, building.height * rise);
    const features = [{
      type: 'Feature',
      properties: {
        part: 'building',
        color: glow ? '#fef08a' : building.color,
        height: currentHeight
      },
      geometry: { type: 'Polygon', coordinates: [ring] }
    }];

    if (!glow) {
      for (const corner of building.coords) {
        features.push({
          type: 'Feature',
          properties: { part: 'scaffold', base: 0, height: currentHeight },
          geometry: { type: 'Polygon', coordinates: postPolygon(corner, 0.24) }
        });
      }
      for (let level = 0.25; level <= rise; level += 0.25) {
        const railBase = building.height * level;
        for (let i = 0; i < building.coords.length; i++) {
          const start = building.coords[i];
          const end = building.coords[(i + 1) % building.coords.length];
          features.push({
            type: 'Feature',
            properties: {
              part: 'scaffold',
              base: railBase,
              height: railBase + 0.12,
            },
            geometry: { type: 'Polygon', coordinates: beamPolygon(start, end, 0.16) }
          });
        }
      }
    } else {
      features.push({
        type: 'Feature',
        properties: { part: 'glow', opacity: 0.45 + glow * 0.55 },
        geometry: { type: 'Polygon', coordinates: [ring] }
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function start(building) {
    if (!map.getSource(SOURCE_ID)) return false;
    const existing = animations.get(building.id);
    if (existing) cancelAnimationFrame(existing.frameId);
    onStart(building.id);
    const startedAt = performance.now();
    const animate = now => {
      const progress = Math.min(1, (now - startedAt) / DURATION_MS);
      const rise = Math.min(1, progress / RISE_FRACTION);
      const glow = progress <= RISE_FRACTION ? 0 : (progress - RISE_FRACTION) / (1 - RISE_FRACTION);
      const source = map.getSource(SOURCE_ID);
      if (source) source.setData(buildFrame(building, rise, glow));
      if (progress < 1) {
        animations.set(building.id, { frameId: requestAnimationFrame(animate) });
        return;
      }
      animations.delete(building.id);
      if (source) source.setData({ type: 'FeatureCollection', features: [] });
      onFinish(building.id);
    };
    animations.set(building.id, { frameId: requestAnimationFrame(animate) });
    return true;
  }

  return { ensureLayers, start };
}