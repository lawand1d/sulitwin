export function tileBounds(z, x, y) {
  const n = Math.pow(2, z);
  const lonW = x / n * 360 - 180;
  const lonE = (x + 1) / n * 360 - 180;
  const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return [lonW, latS, lonE, latN];
}

export function intersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

export function parseTileZXY(url) {
  const m = url.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.(?:pbf|mvt|vector\.pbf|geojson|png|jpg|webp))?(?:\?|$)/);
  if (!m) return null;
  return { z: +m[1], x: +m[2], y: +m[3] };
}

export function centerOfCoordinates(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function geometryCenter(geometry) {
  let coords = null;
  if (geometry.type === 'Polygon') coords = geometry.coordinates[0];
  else if (geometry.type === 'MultiPolygon' && geometry.coordinates.length) coords = geometry.coordinates[0][0];
  if (!coords || coords.length < 3) return null;
  return centerOfCoordinates(coords);
}

export function lngLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { z, x, y };
}

export function zoneCircleCoords(center, radiusMeters, segments = 64) {
  const [lon, lat] = center;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const mLat = 111320;
  const mLon = 111320 * cosLat;
  const coords = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    coords.push([
      lon + (radiusMeters * Math.cos(a)) / mLon,
      lat + (radiusMeters * Math.sin(a)) / mLat
    ]);
  }
  coords.push(coords[0]);
  return coords;
}

export function haversineMeters(lon1, lat1, lon2, lat2) {
  const R = 6371008.8;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const dφ = (lat2 - lat1) * Math.PI / 180;
  const dλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function numToLetters(n) {
  let s = '';
  n = n + 1;
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

export function displayHeight(h) {
  const c = Math.max(0, Math.min(200, h));
  return 3 + c * (197 / 200);
}

export function canonicalZoneClass(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'flood') return 'Flood';
  if (v === 'green') return 'Green';
  if (v === 'shade') return 'Shade';
  return null;
}

export function parseZoneArgs(text) {
  let radius = null;
  let cls = null;
  let rest = String(text);
  let m = rest.match(/\bradius\s+(\d+(?:\.\d+)?)\s*m?/i);
  if (m) { radius = parseFloat(m[1]); rest = rest.replace(m[0], ' '); }
  if (radius === null) {
    m = rest.match(/\br\s*=\s*(\d+(?:\.\d+)?)\s*m?/i);
    if (m) { radius = parseFloat(m[1]); rest = rest.replace(m[0], ' '); }
  }
  if (radius === null) {
    m = rest.match(/(\d+(?:\.\d+)?)\s*m\b/i);
    if (m) { radius = parseFloat(m[1]); rest = rest.replace(m[0], ' '); }
  }
  m = rest.match(/\bclass\s+(Flood|Green|Shade)\b/i);
  if (m) { cls = canonicalZoneClass(m[1]); rest = rest.replace(m[0], ' '); }
  if (cls === null) {
    m = rest.match(/\bc\s*=\s*(Flood|Green|Shade)\b/i);
    if (m) { cls = canonicalZoneClass(m[1]); rest = rest.replace(m[0], ' '); }
  }
  if (cls === null) {
    m = rest.match(/\b(Flood|Green|Shade)\b/i);
    if (m) { cls = canonicalZoneClass(m[1]); rest = rest.replace(m[0], ' '); }
  }
  if (radius === null) {
    m = rest.match(/(\d+(?:\.\d+)?)/);
    if (m) radius = parseFloat(m[1]);
  }
  return { radius, cls };
}

export function parseBuildingArgs(text) {
  let height = null;
  let rest = String(text);
  let m = rest.match(/\bheight\s+(\d+(?:\.\d+)?)\s*m?/i);
  if (m) { height = parseFloat(m[1]); rest = rest.replace(m[0], ' '); }
  if (height === null) {
    m = rest.match(/\bh\s*=\s*(\d+(?:\.\d+)?)\s*m?/i);
    if (m) { height = parseFloat(m[1]); rest = rest.replace(m[0], ' '); }
  }
  if (height === null) {
    m = rest.match(/(\d+(?:\.\d+)?)\s*m\b/i);
    if (m) { height = parseFloat(m[1]); rest = rest.replace(m[0], ' '); }
  }
  const coords = [];
  const coordRe = /(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/g;
  let cm;
  while ((cm = coordRe.exec(rest)) !== null) {
    coords.push([parseFloat(cm[1]), parseFloat(cm[2])]);
  }
  if (height === null) {
    const cleaned = rest.replace(coordRe, ' ');
    const numMatch = cleaned.match(/(\d+(?:\.\d+)?)/);
    if (numMatch) height = parseFloat(numMatch[1]);
  }
  return { height, coords };
}
