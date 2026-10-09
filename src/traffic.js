import { haversineMeters } from './helpers.js';

export function preparePath(coords, cls) {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    cum.push(total);
  }
  return { id: `rp-${Math.random().toString(36).slice(2, 10)}`, coords, cum, length: total, cls };
}

export function stitchRoadSegments(segments) {
  const key = (lon, lat) => `${lon.toFixed(5)},${lat.toFixed(5)}`;
  const index = new Map();
  segments.forEach((seg, i) => {
    const a = `${seg.cls}|${key(seg.coords[0][0], seg.coords[0][1])}`;
    const b = `${seg.cls}|${key(seg.coords[seg.coords.length - 1][0], seg.coords[seg.coords.length - 1][1])}`;
    if (!index.has(a)) index.set(a, []);
    if (!index.has(b)) index.set(b, []);
    index.get(a).push({ seg: i, side: 0 });
    index.get(b).push({ seg: i, side: 1 });
  });
  const used = new Array(segments.length).fill(false);
  const paths = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let coords = segments[i].coords.slice();
    const cls = segments[i].cls;
    const extend = (atEnd) => {
      while (true) {
        const endpoint = atEnd ? coords[coords.length - 1] : coords[0];
        const endpointKey = `${cls}|${key(endpoint[0], endpoint[1])}`;
        const connected = index.get(endpointKey) || [];
        if (connected.length !== 2) break;
        const next = connected.find(item => !used[item.seg]);
        if (!next) break;
        used[next.seg] = true;
        let nextCoords = segments[next.seg].coords;
        if ((atEnd && next.side === 1) || (!atEnd && next.side === 0)) nextCoords = nextCoords.slice().reverse();
        if (atEnd) coords = coords.concat(nextCoords.slice(1));
        else coords = nextCoords.slice(0, -1).concat(coords);
      }
    };
    extend(true);
    extend(false);
    if (coords.length >= 2) paths.push({ coords, cls });
  }
  return paths;
}

export function randomCarColor(CAR_COLORS = []) {
  const palette = Array.isArray(CAR_COLORS) && CAR_COLORS.length ? CAR_COLORS : [
    [200, 30, 30, 255],
    [30, 60, 200, 255],
    [240, 240, 240, 255],
    [40, 40, 40, 255],
    [180, 180, 190, 255],
    [30, 140, 60, 255],
    [230, 180, 40, 255],
    [140, 60, 160, 255]
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

export function samplePathPosition(path, t, direction, laneOffset) {
  const total = path.length;
  if (total <= 0) return { pos: [0, 0, 0], heading: 0 };
  let d = ((t % total) + total) % total;
  let low = 1;
  let high = path.cum.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (path.cum[mid] < d) low = mid + 1;
    else high = mid;
  }
  const i = low;
  const c0 = path.coords[i - 1];
  const c1 = path.coords[i];
  const segStart = path.cum[i - 1];
  const segEnd = path.cum[i];
  const segT = segEnd > segStart ? (d - segStart) / (segEnd - segStart) : 0;
  const lon = c0[0] + (c1[0] - c0[0]) * segT;
  const lat = c0[1] + (c1[1] - c0[1]) * segT;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const mLon = 111320 * cosLat;
  const mLat = 111320;
  const dLon = (c1[0] - c0[0]) * mLon;
  const dLat = (c1[1] - c0[1]) * mLat;
  const len = Math.hypot(dLon, dLat) || 1;
  const perpX = -dLat / len;
  const perpY = dLon / len;
  const offLon = (perpX * laneOffset) / mLon;
  const offLat = (perpY * laneOffset) / mLat;
  let heading = Math.atan2(dLon, dLat) * 180 / Math.PI;
  if (direction < 0) heading = (heading + 180) % 360;
  return { pos: [lon + offLon, lat + offLat, 0.4], heading };
}

export function carRect(car, fwdOffset, length, width) {
  const [lon, lat] = car.pos;
  const h = car.heading * Math.PI / 180;
  const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
  const fx = Math.sin(h), fy = Math.cos(h);
  const rx = fy, ry = -fx;
  const ring = [];
  for (const [sf, sr] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const f = fwdOffset + sf * length / 2;
    const r = sr * width / 2;
    ring.push([lon + (fx * f + rx * r) / mLon, lat + (fy * f + ry * r) / mLat]);
  }
  ring.push(ring[0]);
  return ring;
}
