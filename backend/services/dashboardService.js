import { zones } from '../data/zones.js';
import { fetchZoneEnvironments } from './openMeteo.js';
import { calculateRisk, recommendation } from './riskEngine.js';
import { persistSnapshot } from './storageService.js';
import { fetchContext } from './osmContext.js';

export async function getDashboard() {
  const environments = await fetchZoneEnvironments(zones);
  let contexts;
  try {
    contexts = await fetchContext(zones);
  } catch (error) {
    console.warn(`Context enrichment unavailable: ${error.message}`);
    contexts = zones.map(() => ({ schools: null, hospitals: null, majorRoads: null, roadExposureProxy: null, activity: null, vulnerabilityAssumption: null, source: 'OpenStreetMap / Overpass unavailable', available: false, amenitiesAvailable: false, roadsAvailable: false, complete: false, methodology: error.message }));
  }
  const results = zones.map((zone, index) => {
    const environment = environments[index];
    const context = contexts[index];
    const riskContext = { ...context, vulnerabilityAssumption: context.vulnerabilityAssumption ?? 50 };
    let risk = null;
    let zoneRecommendation = null;
    let riskError = null;
    try {
      risk = calculateRisk(environment.air, riskContext, environment.weather);
      zoneRecommendation = recommendation({ ...zone, context: riskContext }, risk);
    } catch (error) {
      riskError = error.message;
      console.warn(`Risk unavailable for ${zone.id}: ${riskError}`);
      risk = {
        score: null,
        level: 'UNAVAILABLE',
        unavailable: true,
        components: {
          pollution: null,
          activityExposureProxy: null,
          vulnerabilityAssumption: context.vulnerabilityAssumption ?? 50,
          roadExposureProxy: null,
          windDispersionProxy: null
        },
        contextProvenance: { amenities: context.amenitiesProvenance || 'UNAVAILABLE', roads: context.roadsProvenance || 'UNAVAILABLE', stale: context.stale === true },
        methodology: 'Risk unavailable because one or more required upstream inputs were missing or invalid.'
      };
      zoneRecommendation = { title: 'Risk unavailable', why: riskError };
    }
    return { ...zone, ...environment, context, risk, riskError, recommendation: zoneRecommendation, source: 'Open-Meteo/CAMS modeled air quality and weather at zone centroid; context is derived from OpenStreetMap/Overpass where available.' };
  });
  const modelDataTimestamps = results.flatMap((zone) => [zone.air.modelDataTimestamp, zone.weather.modelDataTimestamp]).filter(Boolean);
  const snapshot = {
    refreshedAt: new Date().toISOString(),
    modelDataTimestamp: modelDataTimestamps.reduce((latest, current) => !latest || current > latest ? current : latest, null),
    methodology: 'Open-Meteo/CAMS modeled air quality and weather + OpenStreetMap-derived context + deterministic exposure model',
    zones: results
  };
  persistSnapshot(snapshot).catch((error) => console.warn(`S3 snapshot persistence failed: ${error.message}`));
  return snapshot;
}
