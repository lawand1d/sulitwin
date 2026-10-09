import { CENTER, DEFAULTS } from './config.js';
import { centerOfCoordinates, geometryCenter } from './helpers.js';

export function syntheticBuildingId(feature) {
  let coords = null;
  if (feature.geometry.type === 'Polygon') coords = feature.geometry.coordinates[0];
  else if (feature.geometry.type === 'MultiPolygon' && feature.geometry.coordinates.length)
    coords = feature.geometry.coordinates[0][0];
  if (!coords || coords.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    if (x1 < minX) minX = x1;
    if (x1 > maxX) maxX = x1;
    if (y1 < minY) minY = y1;
    if (y1 > maxY) maxY = y1;
    area += x1 * y2 - x2 * y1;
  }
  area = Math.abs(area) / 2;
  return `b_${((minX + maxX) / 2).toFixed(8)}_${((minY + maxY) / 2).toFixed(8)}_${area.toFixed(12)}_${coords.length}`;
}

export function buildingKey(f) { return syntheticBuildingId(f); }

export function customBuildingFeature(b) {
  return {
    type: 'Feature',
    properties: {
      custom_id: b.id,
      custom_color: b.color,
      render_height: b.height,
      render_min_height: b.base
    },
    geometry: { type: 'Polygon', coordinates: [[...b.coords, b.coords[0]]] }
  };
}

export function mapBuildingLabelPosition(feature) {
  const coords = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0]
    : feature.geometry.type === 'MultiPolygon' && feature.geometry.coordinates.length ? feature.geometry.coordinates[0][0]
    : null;
  if (!coords || coords.length < 3) return null;
  return centerOfCoordinates(coords);
}

export function buildingLabelText(letter, feature) {
  const props = feature.properties || {};
  const height = Number(props.render_height || 0);
  const base = Number(props.render_min_height || 0);
  return `${letter} ${Math.max(0, Math.round(height + base))}m`;
}

export function buildingLabelAnchor(feature) {
  const center = geometryCenter(feature.geometry);
  if (!center) return [CENTER[0], CENTER[1]];
  return [center[0], center[1]];
}

export function isBuildingFeatureVisible(feature, hiddenBuildingKeys) {
  return !!feature && !hiddenBuildingKeys.has(buildingKey(feature));
}

export function defaultBuildingColor() {
  return DEFAULTS.buildingLabels ? '#7ef29d' : '#7ef29d';
}
