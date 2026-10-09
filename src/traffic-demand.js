const TIME_ZONE = 'Asia/Baghdad';
const MAX_VISIBLE_CARS = 10000;

const DAY_FACTORS = [1, 1, 1, 1.02, 1.05, 0.55, 0.8];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const WEEKDAY_PROFILE = {
  base: 0.06,
  peaks: [
    { center: 8, width: 0.7, height: 0.8 },
    { center: 16.25, width: 0.9, height: 0.7 },
    { center: 21, width: 1.3, height: 0.45 }
  ]
};

const THURSDAY_PROFILE = {
  base: 0.06,
  peaks: [
    { center: 8, width: 0.7, height: 0.78 },
    { center: 15, width: 1.2, height: 0.72 },
    { center: 20, width: 1.8, height: 0.62 }
  ]
};

const FRIDAY_PROFILE = {
  base: 0.06,
  peaks: [
    { center: 12.4, width: 0.55, height: 0.85 },
    { center: 20.5, width: 2, height: 0.7 },
    { center: 23, width: 1.2, height: 0.35 }
  ]
};

const SATURDAY_PROFILE = {
  base: 0.06,
  peaks: [
    { center: 13, width: 2.2, height: 0.8 },
    { center: 20.5, width: 1.8, height: 0.65 }
  ]
};

const SUMMER_PROFILE = {
  base: 0.06,
  peaks: [
    { center: 7, width: 0.8, height: 0.8 },
    { center: 17, width: 1, height: 0.7 },
    { center: 22, width: 1.6, height: 0.45 }
  ]
};

function localParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(timestamp);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function profileFor(day, month) {
  if (month >= 6 && month <= 8) return { profile: SUMMER_PROFILE, season: 'summer', seasonFactor: 0.8 };
  if (month === 12 || month <= 2) {
    return {
      profile: day === 4 ? THURSDAY_PROFILE : day === 5 ? FRIDAY_PROFILE : day === 6 ? SATURDAY_PROFILE : WEEKDAY_PROFILE,
      season: 'winter',
      seasonFactor: 0.95
    };
  }
  return {
    profile: day === 4 ? THURSDAY_PROFILE : day === 5 ? FRIDAY_PROFILE : day === 6 ? SATURDAY_PROFILE : WEEKDAY_PROFILE,
    season: 'normal',
    seasonFactor: 1
  };
}

function gaussianDistance(hour, center) {
  const distance = Math.abs(hour - center);
  return Math.min(distance, 24 - distance);
}

function rawDemand(hour, profile) {
  return profile.base + profile.peaks.reduce((sum, peak) => {
    const distance = gaussianDistance(hour, peak.center);
    return sum + peak.height * Math.exp(-(distance * distance) / (2 * peak.width * peak.width));
  }, 0);
}

function peakName(hour, day, season) {
  if (day === 5 && season !== 'summer' && Math.abs(gaussianDistance(hour, 12.4)) < 0.8) return 'prayer peak';
  if (hour < 5) return 'night';
  if (season === 'summer') {
    if (Math.abs(gaussianDistance(hour, 7)) < 1.2) return 'morning peak';
    if (Math.abs(gaussianDistance(hour, 17)) < 1.5) return 'afternoon peak';
    if (Math.abs(gaussianDistance(hour, 22)) < 2) return 'evening peak';
  } else {
    const peaks = day === 4
      ? [[8, 'morning peak'], [15, 'afternoon peak'], [20, 'evening peak']]
      : day === 5
        ? [[20.5, 'evening peak'], [23, 'late peak']]
        : day === 6
          ? [[13, 'daytime peak'], [20.5, 'evening peak']]
          : [[8, 'morning peak'], [16.25, 'afternoon peak'], [21, 'evening peak']];
    for (const [center, label] of peaks) {
      if (Math.abs(gaussianDistance(hour, center)) < 1.2) return label;
    }
  }
  return 'off-peak';
}

export function trafficDemandAt(timestamp = new Date()) {
  const parts = localParts(timestamp);
  const roundedMinute = Math.round(parts.minute / 5) * 5;
  const snapped = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, roundedMinute));
  const day = snapped.getUTCDay();
  const month = snapped.getUTCMonth() + 1;
  const hour = snapped.getUTCHours() + snapped.getUTCMinutes() / 60;
  const { profile, season, seasonFactor } = profileFor(day, month);

  let maximumDemand = 0;
  for (let minute = 0; minute < 1440; minute += 5) {
    maximumDemand = Math.max(maximumDemand, rawDemand(minute / 60, profile));
  }
  const demandFactor = rawDemand(hour, profile) / maximumDemand;
  const seasonalDemand = demandFactor * DAY_FACTORS[day] * seasonFactor;
  const count = Math.min(MAX_VISIBLE_CARS, Math.max(0, Math.round(MAX_VISIBLE_CARS * seasonalDemand)));
  const label = peakName(hour, day, season);

  return {
    count,
    time: `${String(snapped.getUTCHours()).padStart(2, '0')}:${String(snapped.getUTCMinutes()).padStart(2, '0')}`,
    day: DAY_NAMES[day],
    season,
    profile: `${label} · ${DAY_NAMES[day]} · ${season}`,
    factor: seasonalDemand
  };
}