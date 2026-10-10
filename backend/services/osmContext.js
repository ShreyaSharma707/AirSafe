import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const overpassUrl = 'https://overpass-api.de/api/interpreter';
const overpassFallbackUrl = 'https://overpass.kumi.systems/api/interpreter';
const zonesGeoJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'zones.geojson');
const osmCachePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'osm-context-cache.json');
const REQUEST_TIMEOUT_MS = 10000;
const OSM_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OSM_CACHE_SCHEMA_VERSION = 1;

function isUsableCachedComponent(component) {
  if (component?.available !== true || !component.savedAt) return false;
  const savedAt = Date.parse(component.savedAt);
  return Number.isFinite(savedAt) && Date.now() - savedAt <= OSM_CACHE_MAX_AGE_MS;
}

function loadZoneFeatures() {
  const geojson = JSON.parse(fs.readFileSync(zonesGeoJsonPath, 'utf8'));
  const features = geojson.features.filter((feature) => feature.geometry?.type === 'Polygon');
  console.log(`Loaded zone features: ${features.length}`);
  if (features.length !== 9) throw new Error(`Expected 9 polygon zone features, found ${features.length}`);
  return features;
}

const zoneFeatures = loadZoneFeatures();

function pointOnSegment(point, start, end) {
  const [x, y] = point;
  const cross = (y - start[1]) * (end[0] - start[0]) - (x - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-10) return false;
  return x >= Math.min(start[0], end[0]) && x <= Math.max(start[0], end[0])
    && y >= Math.min(start[1], end[1]) && y <= Math.max(start[1], end[1]);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const intersects = ((currentPoint[1] > point[1]) !== (previousPoint[1] > point[1]))
      && point[0] < ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) / (previousPoint[1] - currentPoint[1]) + currentPoint[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  const [outerRing, ...holes] = polygon.coordinates;
  return pointInRing(point, outerRing) && !holes.some((hole) => pointInRing(point, hole));
}

function elementPoint(element) {
  if (Number.isFinite(element.lon) && Number.isFinite(element.lat)) return [element.lon, element.lat];
  if (Number.isFinite(element.center?.lon) && Number.isFinite(element.center?.lat)) {
    return [element.center.lon, element.center.lat];
  }
  return null;
}

function classifyElement(element) {
  if (element.tags?.amenity === 'school') return 'schools';
  if (element.tags?.amenity === 'hospital') return 'hospitals';
  if (element.tags?.highway) return 'majorRoads';
  return null;
}

function assignZone(point, zoneFeatures) {
  return zoneFeatures.find((feature) => pointInPolygon(point, feature.geometry))?.properties.id || null;
}

export function assignElementsToZones(elements, zones = zoneFeatures) {
  const assignmentZones = zones.map((zone) => zone.geometry ? zone : zoneFeatures.find((feature) => feature.properties.id === zone.id)).filter(Boolean);
  const assigned = new Map();

  for (const element of elements) {
    const category = classifyElement(element);
    const point = elementPoint(element);
    if (!category || !point) continue;
    const zoneId = assignZone(point, assignmentZones);
    if (zoneId) assigned.set(`${element.type || 'element'}/${element.id}`, { category, zoneId });
  }

  return assigned;
}

export async function fetchContext(zones) {
  const amenityQuery = '[out:json][timeout:25];nwr["amenity"~"school|hospital"](28.40,76.85,28.80,77.50);out center qt;';
  const roadQuery = '[out:json][timeout:60];way["highway"~"^(motorway|trunk|primary|secondary)$"](28.40,76.85,28.80,77.50);out center qt;';
  const requestOverpass = async (query, label) => {
    let lastError;
    for (const endpoint of [overpassUrl, overpassFallbackUrl]) {
      const startedAt = Date.now();
      try {
        const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Accept: 'application/json', 'User-Agent': 'AirSafe/1.0' }
        });
        const responseText = await response.text();
        console.log(`Overpass ${label}: endpoint=${endpoint}; status=${response.status}; response time=${Date.now() - startedAt}ms; body size=${Buffer.byteLength(responseText)} bytes`);
        if (!response.ok) {
          lastError = new Error(`${label} request failed (${response.status}): ${responseText.slice(0, 300)}`);
          continue;
        }
        try {
          return JSON.parse(responseText);
        } catch (error) {
          lastError = new Error(`${label} response parsing failed: ${error.message}`);
        }
      } catch (error) {
        lastError = new Error(`${label} request error: ${error.message}`);
      }
    }
    throw lastError;
  };

  const [amenityResult, roadResult] = await Promise.allSettled([
    requestOverpass(amenityQuery, 'amenity'),
    requestOverpass(roadQuery, 'roads')
  ]);
  const amenityElements = amenityResult.status === 'fulfilled' ? amenityResult.value.elements || [] : [];
  const roadElements = roadResult.status === 'fulfilled' ? roadResult.value.elements || [] : [];
  const amenitiesAvailable = amenityResult.status === 'fulfilled';
  const roadsAvailable = roadResult.status === 'fulfilled';
  if (amenityResult.status === 'rejected') console.warn(`Overpass amenity data unavailable: ${amenityResult.reason.message}`);
  if (roadResult.status === 'rejected') console.warn(`Overpass road data unavailable: ${roadResult.reason.message}`);

  let cachedContexts = null;
  try {
    const cachedFile = JSON.parse(await fsPromises.readFile(osmCachePath, 'utf8'));
    cachedContexts = cachedFile.schemaVersion === OSM_CACHE_SCHEMA_VERSION ? cachedFile.zones : null;
  } catch {
    cachedContexts = null;
  }
  const liveContextsAvailable = amenitiesAvailable || roadsAvailable;
  const elements = [...amenityElements, ...roadElements];
  console.log(`OSM element counts: amenities=${amenityElements.length}; roads=${roadElements.length}; total=${elements.length}`);
  const assigned = assignElementsToZones(elements, zones);
  console.log(`OSM assigned elements: amenities=${[...assigned.values()].filter(({ category }) => category === 'schools' || category === 'hospitals').length}; roads=${[...assigned.values()].filter(({ category }) => category === 'majorRoads').length}`);
  console.log('OSM assignment samples:', elements.slice(0, 10).map((element) => {
    const point = elementPoint(element);
    const assignment = assigned.get(`${element.type || 'element'}/${element.id}`);
    return { id: element.id, type: element.type, latitude: point?.[1] ?? null, longitude: point?.[0] ?? null, assignedZone: assignment?.zoneId ?? null };
  }));
  const counts = new Map(zones.map((zone) => [zone.id, { schools: 0, hospitals: 0, majorRoads: 0 }]));
  for (const { category, zoneId } of assigned.values()) counts.get(zoneId)[category] += 1;

  const contexts = zones.map((zone, index) => {
    const count = counts.get(zone.id);
    const cached = cachedContexts?.find((context) => context.zoneId === zone.id);
    const useCachedAmenities = !amenitiesAvailable && isUsableCachedComponent(cached?.amenities);
    const useCachedRoads = !roadsAvailable && isUsableCachedComponent(cached?.roads);
    const hasAmenities = amenitiesAvailable || useCachedAmenities;
    const hasRoads = roadsAvailable || useCachedRoads;
    const complete = hasAmenities && hasRoads;
    const available = complete;
    const amenitiesStale = useCachedAmenities;
    const roadsStale = useCachedRoads;
    const stale = amenitiesStale || roadsStale;
    const amenitiesProvenance = amenitiesAvailable ? 'LIVE' : useCachedAmenities ? 'CACHED' : 'UNAVAILABLE';
    const roadsProvenance = roadsAvailable ? 'LIVE' : useCachedRoads ? 'CACHED' : 'UNAVAILABLE';
    return {
      zoneId: zone.id,
      schools: amenitiesAvailable ? count.schools : useCachedAmenities ? cached.amenities.schools : null,
      hospitals: amenitiesAvailable ? count.hospitals : useCachedAmenities ? cached.amenities.hospitals : null,
      majorRoads: roadsAvailable ? count.majorRoads : useCachedRoads ? cached.roads.majorRoads : null,
      roadExposureProxy: roadsAvailable ? Math.min(100, count.majorRoads * 8) : useCachedRoads ? cached.roads.roadExposureProxy : null,
      activity: amenitiesAvailable ? Math.min(100, count.schools * 2) : useCachedAmenities ? cached.amenities.activity : null,
      vulnerabilityAssumption: null,
      source: complete ? stale ? 'OpenStreetMap / Overpass (partially cached)' : 'OpenStreetMap / Overpass' : 'OpenStreetMap / Overpass incomplete',
      available,
      amenitiesAvailable: hasAmenities,
      roadsAvailable: hasRoads,
      complete,
      amenitiesStale,
      roadsStale,
      amenitiesProvenance,
      roadsProvenance,
      stale: amenitiesStale || roadsStale,
      amenitiesCachedAt: amenitiesStale ? cached.amenities.savedAt : null,
      roadsCachedAt: roadsStale ? cached.roads.savedAt : null,
      cachedAt: amenitiesStale && roadsStale
        ? [cached.amenities.savedAt, cached.roads.savedAt].filter(Boolean).sort()[0] || null
        : amenitiesStale ? cached.amenities.savedAt : roadsStale ? cached.roads.savedAt : null,
      methodology: complete
        ? 'Features assigned to exactly one zone by GeoJSON point-in-polygon; road exposure proxy is a normalized planning metric, not traffic measurement.'
        : 'OpenStreetMap / Overpass context is incomplete; both amenity and road inputs are required for risk calculation.'
    };
  });
  console.log('OSM context examples:', contexts.slice(0, 3).map((context, index) => ({ zoneId: zones[index].id, ...context })));
  if (liveContextsAvailable) {
    try {
      const cacheZones = contexts.map((context) => ({
        zoneId: context.zoneId,
        amenities: {
          available: context.amenitiesAvailable,
          stale: context.amenitiesStale,
          savedAt: context.amenitiesStale ? context.amenitiesCachedAt : context.amenitiesAvailable ? new Date().toISOString() : null,
          schools: context.schools,
          hospitals: context.hospitals,
          activity: context.activity
        },
        roads: {
          available: context.roadsAvailable,
          stale: context.roadsStale,
          savedAt: context.roadsStale ? context.roadsCachedAt : context.roadsAvailable ? new Date().toISOString() : null,
          majorRoads: context.majorRoads,
          roadExposureProxy: context.roadExposureProxy
        }
      }));
      await fsPromises.writeFile(osmCachePath, JSON.stringify({ schemaVersion: OSM_CACHE_SCHEMA_VERSION, zones: cacheZones }, null, 2));
    } catch (error) {
      console.warn(`OSM cache write failed: ${error.message}`);
    }
  }
  return contexts;
}
