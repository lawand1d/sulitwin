const DEFAULT_TARGET_WAYS = [
  { id: 1165380351, name: 'Sara Park' },
  { id: 1165380486, name: 'Way 1165380486' },
  { id: 1165380485, name: 'Way 1165380485' },
  { id: 370599550, name: 'Way 370599550' }
];

const TREE_TARGET = 12;
const TRUNK_RADIUS_M = 0.45;
const TRUNK_HEIGHT_M = 2.0;
const FOLIAGE_RADIUS_M = 2.0;
const FOLIAGE_BASE_M = 1.6;
const FOLIAGE_HEIGHT_M = 5.0;
const TREE_EDGE_MARGIN_M = 2.0;

const FENCE_WIDTH_M = 0.6;
const PLINTH_TOP_M = 0.40;
const BARS_TOP_M = 1.10;
const RAIL_TOP_M = 1.28;
const BAND_BOTTOM_M = 0.72;
const BAND_TOP_M = 0.86;
const FINIAL_TOP_M = 1.65;
const FINIAL_SPACING_M = 1.5;

const C_PLINTH = '#c7b89e';
const C_IRON = '#171717';
const C_GOLD = '#d4af37';

export function createParkController({ map, center = [0, 0], dbg = () => {}, targetWays = DEFAULT_TARGET_WAYS } = {}) {
  let parksBuilt = false;

  async function fetchWayGeometry(wayId) {
    const url = `https://api.openstreetmap.org/api/0.6/way/${wayId}/full.json`;
    dbg(`Fetching way ${wayId}...`);
    let res;
    try { res = await fetch(url); }
    catch (err) { dbg(`  ${wayId}: fetch failed - ${err.message}`); return null; }
    dbg(`  ${wayId}: HTTP ${res.status}`);
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); }
    catch (e) { dbg(`  ${wayId}: JSON parse failed`); return null; }
    const elements = data.elements || [];
    const nodes = new Map();
    let way = null;
    for (const el of elements) {
      if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
      else if (el.type === 'way' && el.id === wayId) way = el;
    }
    if (!way || !way.nodes || way.nodes.length < 4) return null;
    const ring = [];
    for (const nid of way.nodes) {
      const p = nodes.get(nid);
      if (p) ring.push(p);
    }
    if (ring.length >= 2) {
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    }
    if (ring.length < 4) return null;
    let sx = 0, sy = 0;
    for (const [lon, lat] of ring) { sx += lon; sy += lat; }
    dbg(`  ${wayId}: verts=${ring.length} centroid=${(sx / ring.length).toFixed(5)},${(sy / ring.length).toFixed(5)}`);
    return ring;
  }

  function buildFenceWall(ring, widthMeters) {
    const cosLat = Math.cos(center[1] * Math.PI / 180);
    const mLat = 111320, mLon = 111320 * cosLat;
    const halfW = widthMeters / 2;
    const features = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      const x1 = lon1 * mLon, y1 = lat1 * mLat;
      const x2 = lon2 * mLon, y2 = lat2 * mLat;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      const px = (-dy / len) * halfW, py = (dx / len) * halfW;
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [(x1 + px) / mLon, (y1 + py) / mLat], [(x2 + px) / mLon, (y2 + py) / mLat],
            [(x2 - px) / mLon, (y2 - py) / mLat], [(x1 - px) / mLon, (y1 - py) / mLat],
            [(x1 + px) / mLon, (y1 + py) / mLat]
          ]]
        }
      });
    }
    return features;
  }

  function buildFinialsAlongRing(ring, spacingM, halfSizeM) {
    const cosLat = Math.cos(center[1] * Math.PI / 180);
    const mLon = 111320 * cosLat, mLat = 111320;
    const pts = ring.map(([lon, lat]) => [lon * mLon, lat * mLat]);
    const cum = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      cum.push(total);
    }
    const halfLon = halfSizeM / mLon, halfLat = halfSizeM / mLat;
    const features = [];
    for (let d = spacingM * 0.5; d < total - spacingM * 0.2; d += spacingM) {
      let i = 1;
      while (i < cum.length && cum[i] < d) i++;
      if (i >= cum.length) break;
      const segLen = cum[i] - cum[i - 1];
      const t = segLen > 0 ? (d - cum[i - 1]) / segLen : 0;
      const px = pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]);
      const py = pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]);
      const cx = px / mLon, cy = py / mLat;
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [cx - halfLon, cy - halfLat], [cx + halfLon, cy - halfLat],
            [cx + halfLon, cy + halfLat], [cx - halfLon, cy + halfLat],
            [cx - halfLon, cy - halfLat]
          ]]
        }
      });
    }
    return features;
  }

  function addRoyalFence(ring, tag) {
    const wallFeatures = buildFenceWall(ring, FENCE_WIDTH_M);
    if (!wallFeatures.length) return;
    const wallSrcId = `royal-fence-${tag}`;
    map.addSource(wallSrcId, { type: 'geojson', data: { type: 'FeatureCollection', features: wallFeatures } });
    map.addLayer({
      id: `${wallSrcId}-plinth`, type: 'fill-extrusion', source: wallSrcId,
      paint: { 'fill-extrusion-color': C_PLINTH, 'fill-extrusion-height': PLINTH_TOP_M, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 1 }
    });
    map.addLayer({
      id: `${wallSrcId}-bars`, type: 'fill-extrusion', source: wallSrcId,
      paint: { 'fill-extrusion-color': C_IRON, 'fill-extrusion-height': BARS_TOP_M, 'fill-extrusion-base': PLINTH_TOP_M, 'fill-extrusion-opacity': 1 }
    });
    map.addLayer({
      id: `${wallSrcId}-rail`, type: 'fill-extrusion', source: wallSrcId,
      paint: { 'fill-extrusion-color': C_IRON, 'fill-extrusion-height': RAIL_TOP_M, 'fill-extrusion-base': BARS_TOP_M, 'fill-extrusion-opacity': 1 }
    });
    map.addLayer({
      id: `${wallSrcId}-band`, type: 'fill-extrusion', source: wallSrcId,
      paint: { 'fill-extrusion-color': C_GOLD, 'fill-extrusion-height': BAND_TOP_M, 'fill-extrusion-base': BAND_BOTTOM_M, 'fill-extrusion-opacity': 1 }
    });
    const finials = buildFinialsAlongRing(ring, FINIAL_SPACING_M, 0.18);
    if (!finials.length) return;
    const finialSrcId = `royal-fence-${tag}-finials`;
    map.addSource(finialSrcId, { type: 'geojson', data: { type: 'FeatureCollection', features: finials } });
    map.addLayer({
      id: finialSrcId, type: 'fill-extrusion', source: finialSrcId,
      paint: { 'fill-extrusion-color': C_GOLD, 'fill-extrusion-height': FINIAL_TOP_M, 'fill-extrusion-base': RAIL_TOP_M, 'fill-extrusion-opacity': 1 }
    });
    dbg(`  ${tag}: royal fence + ${finials.length} finials`);
  }

  function pointInRing(pt, ring) {
    const [x, y] = pt;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const it = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
      if (it) inside = !inside;
    }
    return inside;
  }

  function distanceToRingMeters(pt, ring, mLon, mLat) {
    const px = pt[0] * mLon, py = pt[1] * mLat;
    let best = Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = ring[i][0] * mLon, ay = ring[i][1] * mLat;
      const bx = ring[i + 1][0] * mLon, by = ring[i + 1][1] * mLat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = Math.hypot(px - cx, py - cy);
      if (d < best) best = d;
    }
    return best;
  }

  function circlePolygon(lon, lat, radiusM, sides, cosLat) {
    const mLat = 111320;
    const mLon = 111320 * cosLat;
    const ring = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * 2 * Math.PI;
      ring.push([lon + (radiusM * Math.cos(a)) / mLon, lat + (radiusM * Math.sin(a)) / mLat]);
    }
    return ring;
  }

  function generateTreeGrid(ring, targetCount) {
    const cosLat = Math.cos(center[1] * Math.PI / 180);
    const mLon = 111320 * cosLat, mLat = 111320;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    const widthM = (maxLon - minLon) * mLon;
    const heightM = (maxLat - minLat) * mLat;
    const aspect = widthM / heightM;
    let ny = Math.max(1, Math.round(Math.sqrt(targetCount / aspect)));
    let nx = Math.max(1, Math.round(targetCount / ny));
    const positions = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const tx = (i + 0.5) / nx, ty = (j + 0.5) / ny;
        const lon = minLon + tx * (maxLon - minLon);
        const lat = minLat + ty * (maxLat - minLat);
        if (!pointInRing([lon, lat], ring)) continue;
        const dEdge = distanceToRingMeters([lon, lat], ring, mLon, mLat);
        if (dEdge < TREE_EDGE_MARGIN_M) continue;
        positions.push([lon, lat]);
      }
    }
    return positions;
  }

  function addParkTrees(ring, tag) {
    const positions = generateTreeGrid(ring, TREE_TARGET);
    if (!positions.length) return;
    const cosLat = Math.cos(center[1] * Math.PI / 180);
    const trunkFeatures = [], foliageFeatures = [];
    for (const [lon, lat] of positions) {
      const j = 0.90 + Math.random() * 0.20;
      trunkFeatures.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [circlePolygon(lon, lat, TRUNK_RADIUS_M * j, 6, cosLat)] }
      });
      foliageFeatures.push({
        type: 'Feature',
        properties: { base: FOLIAGE_BASE_M * j, top: FOLIAGE_HEIGHT_M * j },
        geometry: { type: 'Polygon', coordinates: [circlePolygon(lon, lat, FOLIAGE_RADIUS_M * j, 8, cosLat)] }
      });
    }
    map.addSource(`park-trees-${tag}-trunks`, { type: 'geojson', data: { type: 'FeatureCollection', features: trunkFeatures } });
    map.addSource(`park-trees-${tag}-foliage`, { type: 'geojson', data: { type: 'FeatureCollection', features: foliageFeatures } });
    map.addLayer({
      id: `park-trees-${tag}-trunks`, type: 'fill-extrusion', source: `park-trees-${tag}-trunks`,
      paint: { 'fill-extrusion-color': '#5d4037', 'fill-extrusion-height': TRUNK_HEIGHT_M, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 1 }
    });
    map.addLayer({
      id: `park-trees-${tag}-foliage`, type: 'fill-extrusion', source: `park-trees-${tag}-foliage`,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'top'], 3.5, '#4caf50', 5.5, '#2e7d32', 7.0, '#1b5e20'],
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-opacity': 1
      }
    });
    dbg(`  ${tag}: ${positions.length} trees placed`);
  }

  async function buildAllParks() {
    if (parksBuilt) return;
    parksBuilt = true;
    for (const way of targetWays) {
      const tag = String(way.id);
      try {
        const ring = await fetchWayGeometry(way.id);
        if (!ring) { dbg(`${tag}: geometry unavailable`); continue; }
        addRoyalFence(ring, tag);
        addParkTrees(ring, tag);
        dbg(`${tag} (${way.name}) done.`);
      } catch (err) { dbg(`${tag}: error - ${err.message}`); }
    }
    dbg('All parks processed.');
  }

  return { buildAllParks };
}
