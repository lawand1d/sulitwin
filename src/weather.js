function weatherCodeInfo(code) {
  const descriptions = {
    0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
    51: ['Light drizzle', '🌦️'], 53: ['Moderate drizzle', '🌦️'], 55: ['Dense drizzle', '🌧️'],
    56: ['Light freezing drizzle', '🌧️'], 57: ['Dense freezing drizzle', '🌧️'],
    61: ['Slight rain', '🌦️'], 63: ['Moderate rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Light freezing rain', '🌧️'], 67: ['Heavy freezing rain', '🌧️'],
    71: ['Slight snow', '🌨️'], 73: ['Moderate snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
    80: ['Slight rain showers', '🌦️'], 81: ['Moderate rain showers', '🌧️'], 82: ['Violent rain showers', '⛈️'],
    85: ['Slight snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm w/ hail', '⛈️'], 99: ['Thunderstorm w/ heavy hail', '⛈️']
  };
  return descriptions[code] || ['Unknown', '❔'];
}

function visibilityToOpacity(visM, state) {
  if (state.hazeMode === 'force') return state.hazeForce;
  if (visM == null || isNaN(visM)) return 0;
  if (visM >= 20000) return 0;
  if (visM <= 200) return 0.88;
  const t = (Math.log(visM) - Math.log(200)) / (Math.log(20000) - Math.log(200));
  return 0.88 * (1 - t);
}

export function createWeatherController({ map, state, elements, dbg }) {
  let lastWeatherKey = null;
  let requestController = null;
  let debounceTimer = null;
  let refreshInterval = null;
  let bound = false;

  async function fetchWeather(lon, lat) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (key === lastWeatherKey && state.hazeMode === 'live') return;
    lastWeatherKey = key;
    if (requestController) requestController.abort();
    requestController = new AbortController();
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,visibility` +
      `&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto`;
    try {
      const response = await fetch(url, { signal: requestController.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      const current = data.current || {};
      const [description, icon] = weatherCodeInfo(current.weather_code);
      const visibility = current.visibility;
      elements.icon.textContent = icon;
      elements.temperature.textContent = `${Math.round(current.temperature_2m)}°C`;
      elements.description.textContent = description;
      const visibilityText = visibility == null ? '—' :
        visibility >= 1000 ? `${(visibility / 1000).toFixed(1)} km` : `${Math.round(visibility)} m`;
      elements.extra.textContent =
        `💧 ${current.relative_humidity_2m}%   💨 ${Math.round(current.wind_speed_10m)} km/h\n👁️ ${visibilityText}`;
      const opacity = visibilityToOpacity(visibility, state);
      elements.overlay.style.opacity = opacity;
      const note = state.hazeMode === 'force' ? ` [FORCED ${state.hazeForce}]` : '';
      dbg(`Weather: ${description}, ${Math.round(current.temperature_2m)}°C, vis=${visibilityText} → haze ${opacity.toFixed(2)}${note}`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      elements.icon.textContent = '⚠️';
      elements.temperature.textContent = '—°C';
      elements.description.textContent = 'Unavailable';
      elements.extra.textContent = '';
      elements.overlay.style.opacity = state.hazeMode === 'force' ? state.hazeForce : 0;
      dbg('Weather fetch failed: ' + error.message);
    }
  }

  function updateWeather() {
    const center = map.getCenter();
    return fetchWeather(center.lng, center.lat);
  }

  const controller = {
    update: updateWeather,
    resetCache() { lastWeatherKey = null; },
    bind() {
      if (bound) return controller;
      bound = true;
      map.on('load', updateWeather);
      map.on('moveend', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateWeather, 800);
      });
      refreshInterval = setInterval(updateWeather, 10 * 60 * 1000);
      return controller;
    },
    dispose() {
      clearTimeout(debounceTimer);
      if (refreshInterval) clearInterval(refreshInterval);
      if (requestController) requestController.abort();
      bound = false;
    }
  };

  return controller;
}
