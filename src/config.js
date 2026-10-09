export const CENTER = [45.443004, 35.557053];
export const RADIUS_METERS = 800;
export const FADE_OUTER_METERS = 900;

export const latDelta = RADIUS_METERS / 111320;
export const lonDelta = RADIUS_METERS / (111320 * Math.cos(CENTER[1] * Math.PI / 180));
export const REGION = [CENTER[0]-lonDelta, CENTER[1]-latDelta, CENTER[0]+lonDelta, CENTER[1]+latDelta];

export const DEFAULTS = {
  roadFill: '#4a9fe0',
  roadOpacity: 0.40,
  casingColor: '#1a1f2e',
  casingOpacity: 1.00,
  hazeMode: 'force',
  hazeForce: 0.20,
  buildings: true,
  labels: false,
  buildingLabels: true,
  ambientOcclusion: true,
  aoIntensity: 0.55,
  aoOffset: 4
};

export const ZONE_CLASSES = {
  Flood: { color: '#2563eb' },
  Green: { color: '#16a34a' },
  Shade: { color: '#6b7280' }
};

export const CAR_COLORS = [
  [200, 30, 30, 255],
  [30, 60, 200, 255],
  [240, 240, 240, 255],
  [40, 40, 40, 255],
  [180, 180, 190, 255],
  [30, 140, 60, 255],
  [230, 180, 40, 255],
  [140, 60, 160, 255]
];
