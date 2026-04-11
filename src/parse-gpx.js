import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'fs';

export function parseGPX(filePath, targetPoints = 3000) {
  const xml = readFileSync(filePath, 'utf-8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  });
  const data = parser.parse(xml);

  const trk = data.gpx.trk;
  const segments = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg];

  const allPoints = [];
  for (const seg of segments) {
    const pts = Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt];
    for (const pt of pts) {
      allPoints.push({
        lat: parseFloat(pt['@_lat']),
        lon: parseFloat(pt['@_lon']),
        ele: parseFloat(pt.ele || 0),
        time: pt.time || null,
      });
    }
  }

  // Compute cumulative distance on FULL point set (preserves switchback detail)
  allPoints[0].dist = 0;
  for (let i = 1; i < allPoints.length; i++) {
    allPoints[i].dist = allPoints[i - 1].dist + haversine(allPoints[i - 1], allPoints[i]);
  }

  // Downsample with nth-point sampling (distances already computed)
  const step = Math.max(1, Math.floor(allPoints.length / targetPoints));
  const points = [];
  for (let i = 0; i < allPoints.length; i += step) {
    points.push(allPoints[i]);
  }
  if (points[points.length - 1] !== allPoints[allPoints.length - 1]) {
    points.push(allPoints[allPoints.length - 1]);
  }

  // Compute raw bearings
  for (let i = 0; i < points.length - 1; i++) {
    points[i].bearing = calcBearing(points[i], points[i + 1]);
  }
  points[points.length - 1].bearing = points.length > 1
    ? points[points.length - 2].bearing
    : 0;

  // Smooth bearings with circular moving average
  const window = 30;
  const smoothed = [];
  for (let i = 0; i < points.length; i++) {
    let sinSum = 0, cosSum = 0;
    const half = Math.floor(window / 2);
    const start = Math.max(0, i - half);
    const end = Math.min(points.length - 1, i + half);
    for (let j = start; j <= end; j++) {
      const rad = points[j].bearing * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
    }
    smoothed[i] = (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;
  }
  for (let i = 0; i < points.length; i++) {
    points[i].bearing = smoothed[i];
  }

  // Bounds (avoid spread on large arrays)
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  let minEle = Infinity, maxEle = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.ele < minEle) minEle = p.ele;
    if (p.ele > maxEle) maxEle = p.ele;
  }

  // Detect overnight stops (time gaps > minGapHours)
  const stops = detectStops(points);

  return {
    points,
    stops,
    totalPoints: allPoints.length,
    bounds: { minLat, maxLat, minLon, maxLon, minEle, maxEle },
    totalDistance: points[points.length - 1].dist,
    name: trk.name || 'Trail',
    type: trk.type || 'unknown',
  };
}

function detectStops(points, minGapHours = 2) {
  const stops = [];
  for (let i = 1; i < points.length; i++) {
    if (!points[i].time || !points[i - 1].time) continue;
    const hours = (new Date(points[i].time) - new Date(points[i - 1].time)) / 3600000;
    if (hours > minGapHours) {
      stops.push({
        index: i - 1,
        lat: points[i - 1].lat,
        lon: points[i - 1].lon,
        ele: points[i - 1].ele,
        hours: Math.round(hours),
      });
    }
  }
  return stops;
}

function calcBearing(p1, p2) {
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const lat1 = p1.lat * Math.PI / 180;
  const lat2 = p2.lat * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversine(p1, p2) {
  const R = 6371000;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(p1.lat * Math.PI / 180) *
            Math.cos(p2.lat * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
