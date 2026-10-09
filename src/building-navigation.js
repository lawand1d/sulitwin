export function createBuildingNavigationController({
  map,
  lookupBuilding,
  hiddenBuildingKeys,
  highlightedBuildings,
  logPrompt
}) {
  function focusBuilding(letterRaw) {
    const entry = lookupBuilding(letterRaw);
    if (!entry) return;
    const [lon, lat] = entry.xy;
    map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 18.5), duration: 900 });
    logPrompt('bot', `Flying to ${entry.letter} at ${lat.toFixed(5)}, ${lon.toFixed(5)}.`);
  }

  function infoAboutBuilding(letterRaw) {
    const entry = lookupBuilding(letterRaw);
    if (!entry) return;
    const [lon, lat] = entry.xy;
    const f = entry.feature;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const mLon = 111320 * cosLat, mLat = 111320;
    let coords = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0]
      : f.geometry.coordinates[0][0];
    let area2 = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i], [x2, y2] = coords[i + 1];
      area2 += (x1 * mLon) * (y2 * mLat) - (x2 * mLon) * (y1 * mLat);
    }
    const areaM2 = Math.abs(area2) / 2;
    const osmLine = entry.osmId != null ? `  osm_id: ${entry.osmId}` : `  osm_id: (custom or synthetic)`;
    logPrompt('info', `Building ${entry.letter}`);
    logPrompt('info', `  syn_id: ${entry.key}`);
    logPrompt('info', osmLine);
    logPrompt('info', `  center: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    logPrompt('info', `  height: ${entry.height} m  (base ${entry.base} m)`);
    logPrompt('info', `  area:   ${Math.round(areaM2)} m²`);
    logPrompt('info', `  hidden: ${hiddenBuildingKeys.has(entry.key) ? 'yes' : 'no'}`);
    logPrompt('info', `  highlighted: ${highlightedBuildings.has(entry.key) ? 'yes' : 'no'}`);
  }

  return {
    focusBuilding,
    infoAboutBuilding
  };
}
