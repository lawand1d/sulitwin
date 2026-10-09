#!/usr/bin/env python3
import json
import math
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
XLSX_PATH = ROOT / 'elevation_salim_raw_contours.xlsx'
OUT_PATH = ROOT / 'data' / 'terrain_salim_dem.json'


def haversine_meters(lon1, lat1, lon2, lat2):
    rlat1 = math.radians(lat1)
    rlon1 = math.radians(lon1)
    rlat2 = math.radians(lat2)
    rlon2 = math.radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(a))


wb = openpyxl.load_workbook(XLSX_PATH, data_only=True)
ws = wb[wb.sheetnames[0]]
points = []
for row in ws.iter_rows(min_row=2, values_only=True):
    if not row or row[0] is None:
        continue
    lat, lon, elev, _, _ = row[:5]
    if lat is None or lon is None or elev is None:
        continue
    points.append({
        'lat': float(lat),
        'lon': float(lon),
        'elevation': float(elev),
    })

if not points:
    raise RuntimeError('No survey points found in XLSX workbook.')

min_lat = min(p['lat'] for p in points)
max_lat = max(p['lat'] for p in points)
min_lon = min(p['lon'] for p in points)
max_lon = max(p['lon'] for p in points)

# Generate a DEM grid with moderate resolution for browser rendering.
# This keeps the file light while preserving the local landform.
width = 130
height = 130
cell_lon = (max_lon - min_lon) / (width - 1)
cell_lat = (max_lat - min_lat) / (height - 1)

# Use inverse-distance weighting to interpolate the point cloud into a raster.
# A modest search radius keeps runtime manageable while still preserving terrain trends.
radius_m = 120

def idw_elev(lat, lon):
    weights = []
    for p in points:
        d = haversine_meters(lon, lat, p['lon'], p['lat'])
        if d <= radius_m:
            # weight falls off smoothly with distance and prevents singularities.
            w = 1.0 / (d + 1.0)
            weights.append((w, p['elevation']))
    if not weights:
        # Fallback to nearest point if the target falls outside the search radius.
        nearest = min(points, key=lambda p: haversine_meters(lon, lat, p['lon'], p['lat']))
        return nearest['elevation']
    total_w = sum(w for w, _ in weights)
    return sum(w * z for w, z in weights) / total_w


grid = []
for y in range(height):
    lat = max_lat - y * cell_lat
    row = []
    for x in range(width):
        lon = min_lon + x * cell_lon
        row.append(round(idw_elev(lat, lon), 2))
    grid.append(row)

payload = {
    'type': 'terrain-dem',
    'width': width,
    'height': height,
    'minLat': min_lat,
    'maxLat': max_lat,
    'minLon': min_lon,
    'maxLon': max_lon,
    'cellLat': cell_lat,
    'cellLon': cell_lon,
    'minElevation': min(float(value) for row in grid for value in row),
    'maxElevation': max(float(value) for row in grid for value in row),
    'elevation': grid,
    'source': XLSX_PATH.name,
    'pointsCount': len(points),
}

OUT_PATH.parent.mkdir(exist_ok=True, parents=True)
OUT_PATH.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
print(f'Wrote {OUT_PATH} with {len(points)} points and DEM grid {width}x{height}.')
