const clamp = (value) => Math.max(0, Math.min(100, value));

export function calculateRisk(air, context, weather) {
  const requiredInputs = {
    pm2_5: air?.pm2_5,
    pm10: air?.pm10,
    activityExposureProxy: context?.activity,
    roadExposureProxy: context?.roadExposureProxy,
    windSpeed: weather?.windSpeed
  };
  const invalidInput = Object.entries(requiredInputs).find(([, value]) => !Number.isFinite(value));
  if (invalidInput) throw new Error(`Risk inputs unavailable: ${invalidInput[0]}`);
  const negativeInput = Object.entries({ pm2_5: air.pm2_5, pm10: air.pm10, windSpeed: weather.windSpeed }).find(([, value]) => value < 0);
  if (negativeInput) throw new Error(`Risk input invalid: ${negativeInput[0]} cannot be negative`);
  const pollution = clamp((air.pm2_5 / 250) * 70 + (air.pm10 / 400) * 30);
  const activityExposureProxy = context.activity;
  const vulnerabilityAssumption = context.vulnerabilityAssumption ?? 50;
  const windDispersionProxy = weather.windSpeed >= 12 ? 20 : weather.windSpeed >= 7 ? 50 : 85;
  const score = Math.round(pollution * .45 + activityExposureProxy * .2 + vulnerabilityAssumption * .15 + context.roadExposureProxy * .1 + windDispersionProxy * .1);
  const level = score <= 25 ? 'LOW' : score <= 50 ? 'MODERATE' : score <= 75 ? 'HIGH' : 'CRITICAL';
  return { score, level, components: { pollution: Math.round(pollution), activityExposureProxy: Math.round(activityExposureProxy), vulnerabilityAssumption: Math.round(vulnerabilityAssumption), roadExposureProxy: Math.round(context.roadExposureProxy), windDispersionProxy }, contextProvenance: { amenities: context.amenitiesProvenance || 'UNAVAILABLE', roads: context.roadsProvenance || 'UNAVAILABLE', stale: context.stale === true }, methodology: 'Pollution 45%, activity exposure proxy 20%, vulnerability assumption 15%, road exposure proxy 10%, wind dispersion proxy 10%. Activity exposure is derived from mapped activity locations; this is a planning proxy, not a measured population exposure index. The road proxy uses a normalized planning coefficient of 8 points per mapped major-road feature; it is not a measured traffic index. Vulnerability is a neutral modeling assumption of 50/100. Wind dispersion is a heuristic based on wind-speed bands, not a physical dispersion model.' };
}

export function simulateRisk(air, context, weather, component, reductionFactor) {
  const simulatedContext = { ...context };
  if (component === 'activityExposureProxy') simulatedContext.activity = context.activity * (1 - reductionFactor);
  if (component === 'roadExposureProxy') simulatedContext.roadExposureProxy = context.roadExposureProxy * (1 - reductionFactor);
  return calculateRisk(air, simulatedContext, weather);
}

export function recommendation(zone, risk) {
  if (zone.context.schools > 0 && risk.score > 60) return { title: 'Move outdoor school activities indoors', why: 'High modeled exposure overlaps with schools mapped in OpenStreetMap near this zone.' };
  if (zone.context.hospitals > 0 && risk.score > 60) return { title: 'Minimize unnecessary outdoor patient movement', why: 'High modeled exposure overlaps with hospitals mapped in OpenStreetMap near this zone.' };
  if (zone.context.roadExposureProxy > 50 && risk.score > 55) return { title: 'Prioritize road-exposure intervention', why: 'Mapped major-road infrastructure from OpenStreetMap is a significant exposure proxy in this zone; it is not a real-time traffic measurement.' };
  return { title: 'Recommend lower-exposure routes and times', why: 'Reducing time outdoors during the modeled peak is the most practical immediate action.' };
}
