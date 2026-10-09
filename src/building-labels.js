export function createBuildingLabelController({
  map,
  state,
  logPrompt,
  numToLetters,
  displayHeight,
  detectFontStack,
  getCurrentVisibleBuildings,
  getLabeledBuildings,
  getHighlightedBuildings,
  getHiddenBuildingKeys,
  getKeyToLetter,
  getLetterToKey,
  getNextLetterIndex,
  setNextLetterIndex,
  refreshBuildings,
  maxBuildingLabels = 10000
}) {
  function updateBuildingLabels() {
    if (!state.buildingLabels) return;
    const entries = (getCurrentVisibleBuildings() || []).slice();
    entries.sort((a, b) => {
      const dy = b.xy[1] - a.xy[1];
      if (Math.abs(dy) > 1e-5) return dy;
      return a.xy[0] - b.xy[0];
    });
    const trimmed = entries.slice(0, maxBuildingLabels);
    const labeledBuildings = getLabeledBuildings();
    labeledBuildings.clear();
    const labelFeatures = [];
    const seenKeys = new Set();
    const keyToLetter = getKeyToLetter();
    const letterToKey = getLetterToKey();
    for (const e of trimmed) {
      const existingLetter = keyToLetter.get(e.key);
      if (existingLetter) {
        labeledBuildings.set(existingLetter, { ...e, letter: existingLetter });
        labelFeatures.push({
          type: 'Feature',
          properties: { letter: existingLetter },
          geometry: { type: 'Point', coordinates: e.xy }
        });
        seenKeys.add(e.key);
      }
    }
    for (const e of trimmed) {
      if (seenKeys.has(e.key)) continue;
      let letter;
      do { letter = numToLetters(getNextLetterIndex()); } while (letterToKey.has(letter));
      setNextLetterIndex(getNextLetterIndex() + 1);
      keyToLetter.set(e.key, letter);
      letterToKey.set(letter, e.key);
      labeledBuildings.set(letter, { ...e, letter });
      labelFeatures.push({
        type: 'Feature',
        properties: { letter },
        geometry: { type: 'Point', coordinates: e.xy }
      });
    }
    const data = { type: 'FeatureCollection', features: labelFeatures };
    if (map.getSource('building-labels-src')) {
      map.getSource('building-labels-src').setData(data);
    } else {
      map.addSource('building-labels-src', { type: 'geojson', data });
    }
    if (!map.getLayer('building-labels')) {
      const fontStack = detectFontStack();
      map.addLayer({
        id: 'building-labels',
        type: 'symbol',
        source: 'building-labels-src',
        layout: {
          'text-field': ['get', 'letter'],
          'text-font': fontStack,
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 11, 18, 18, 19, 22],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-rotation-alignment': 'viewport',
          'text-pitch-alignment': 'viewport'
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0b1220',
          'text-halo-width': 2.5,
          'text-halo-blur': 0.5
        }
      });
    }
    map.setLayoutProperty('building-labels', 'visibility', state.buildings ? 'visible' : 'none');
  }

  function rebuildHighlights() {
    const highlightedBuildings = getHighlightedBuildings();
    const features = [];
    const shadowFeatures = [];
    for (const h of highlightedBuildings.values()) {
      features.push({
        type: 'Feature',
        properties: { color: h.color, height: displayHeight(h.height), base: h.base },
        geometry: h.feature.geometry
      });
      shadowFeatures.push({
        type: 'Feature',
        properties: {},
        geometry: h.feature.geometry
      });
    }
    const data = { type: 'FeatureCollection', features };
    if (map.getSource('building-highlights-src')) {
      map.getSource('building-highlights-src').setData(data);
    } else if (features.length) {
      map.addSource('building-highlights-src', { type: 'geojson', data });
      map.addLayer({
        id: 'building-highlights',
        type: 'fill-extrusion',
        source: 'building-highlights-src',
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'base'],
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': false
        }
      });
    }
    const shadowSrc = map.getSource('buildings-shadow-src');
    if (shadowSrc && map.getSource('buildings-live-src')) {
      const liveData = map.getSource('buildings-live-src')._data || { features: [] };
      const base = [];
      for (const f of liveData.features || []) {
        base.push({ type: 'Feature', properties: {}, geometry: f.geometry });
      }
      for (const s of shadowFeatures) base.push(s);
      shadowSrc.setData({ type: 'FeatureCollection', features: base });
    }
  }

  function lookupBuilding(letterRaw) {
    const letter = String(letterRaw || '').trim().toUpperCase();
    if (!state.buildingLabels) {
      logPrompt('error', 'Turn on labels first: "label buildings"');
      return null;
    }
    const entry = getLabeledBuildings().get(letter);
    if (!entry) {
      logPrompt('error', `No building labeled "${letter}" in view.`);
      return null;
    }
    return entry;
  }

  function highlightBuilding(letterRaw, color) {
    const entry = lookupBuilding(letterRaw);
    if (!entry) return;
    const highlightedBuildings = getHighlightedBuildings();
    highlightedBuildings.set(entry.key, {
      letter: entry.letter,
      color: color || '#ff2d2d',
      feature: entry.feature,
      height: entry.height,
      base: entry.base
    });
    rebuildHighlights();
    refreshBuildings();
    logPrompt('bot', `Building ${entry.letter} highlighted.`);
  }

  function unhighlightBuilding(letterRaw) {
    const entry = lookupBuilding(letterRaw);
    if (!entry) return;
    const highlightedBuildings = getHighlightedBuildings();
    if (highlightedBuildings.delete(entry.key)) {
      rebuildHighlights();
      refreshBuildings();
      logPrompt('bot', `Highlight removed from ${entry.letter}.`);
    } else {
      logPrompt('info', `Building ${entry.letter} wasn't highlighted.`);
    }
  }

  function clearHighlights() {
    const highlightedBuildings = getHighlightedBuildings();
    highlightedBuildings.clear();
    if (map.getLayer('building-highlights')) map.removeLayer('building-highlights');
    if (map.getSource('building-highlights-src')) map.removeSource('building-highlights-src');
    refreshBuildings();
    logPrompt('bot', 'All highlights cleared.');
  }

  function hideBuildingByLetter(letterRaw) {
    const entry = lookupBuilding(letterRaw);
    if (!entry) return;
    const hiddenBuildingKeys = getHiddenBuildingKeys();
    hiddenBuildingKeys.add(entry.key);
    const highlightedBuildings = getHighlightedBuildings();
    highlightedBuildings.delete(entry.key);
    rebuildHighlights();
    refreshBuildings();
    updateBuildingLabels();
    logPrompt('bot', `Building ${entry.letter} hidden.`);
  }

  function showBuildingByLetter(letterRaw) {
    const letter = String(letterRaw || '').trim().toUpperCase();
    const keyToShow = getLetterToKey().get(letter);
    if (!keyToShow) {
      logPrompt('error', `No building is currently assigned letter "${letter}".`);
      return;
    }
    const hiddenBuildingKeys = getHiddenBuildingKeys();
    if (!hiddenBuildingKeys.has(keyToShow)) {
      logPrompt('info', `Building ${letter} is already visible.`);
      return;
    }
    hiddenBuildingKeys.delete(keyToShow);
    refreshBuildings();
    updateBuildingLabels();
    logPrompt('bot', `Building ${letter} shown again.`);
  }

  function listHidden() {
    const hiddenBuildingKeys = getHiddenBuildingKeys();
    const keyToLetter = getKeyToLetter();
    if (!hiddenBuildingKeys.size) { logPrompt('info', 'Nothing hidden.'); return; }
    logPrompt('info', `Hidden buildings: ${hiddenBuildingKeys.size}`);
    for (const k of hiddenBuildingKeys) {
      logPrompt('info', `  ${keyToLetter.get(k) || '?'}  ${k}`);
    }
  }

  function clearHidden() {
    const hiddenBuildingKeys = getHiddenBuildingKeys();
    if (!hiddenBuildingKeys.size) { logPrompt('info', 'Nothing hidden.'); return; }
    const n = hiddenBuildingKeys.size;
    hiddenBuildingKeys.clear();
    refreshBuildings();
    updateBuildingLabels();
    logPrompt('bot', `${n} hidden building(s) restored.`);
  }

  return {
    updateBuildingLabels,
    rebuildHighlights,
    lookupBuilding,
    highlightBuilding,
    unhighlightBuilding,
    clearHighlights,
    hideBuildingByLetter,
    showBuildingByLetter,
    listHidden,
    clearHidden
  };
}
