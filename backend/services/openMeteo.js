const current = 'pm2_5,pm10,nitrogen_dioxide,ozone,carbon_monoxide,sulphur_dioxide';
const REQUEST_TIMEOUT_MS = 15000;

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
  return response.json();
}

export async function fetchZoneEnvironments(zones) {
  const latitudes = zones.map((zone) => zone.center[0]).join(',');
  const longitudes = zones.map((zone) => zone.center[1]).join(',');
  const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitudes}&longitude=${longitudes}&current=${current}&timezone=Asia%2FKolkata`;
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitudes}&longitude=${longitudes}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,surface_pressure&timezone=Asia%2FKolkata`;
  const [airResult, weatherResult] = await Promise.allSettled([getJson(airUrl), getJson(weatherUrl)]);
  const airResponse = airResult.status === 'fulfilled' ? airResult.value : null;
  const weatherResponse = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
  if (airResult.status === 'rejected') console.warn(`Air quality data unavailable: ${airResult.reason.message}`);
  if (weatherResult.status === 'rejected') console.warn(`Weather data unavailable: ${weatherResult.reason.message}`);
  const airData = Array.isArray(airResponse) ? airResponse : airResponse ? [airResponse] : [];
  const weatherData = Array.isArray(weatherResponse) ? weatherResponse : weatherResponse ? [weatherResponse] : [];
  return zones.map((_zone, index) => ({
    air: { pm2_5: airData[index]?.current?.pm2_5 ?? null, pm10: airData[index]?.current?.pm10 ?? null, no2: airData[index]?.current?.nitrogen_dioxide ?? null, o3: airData[index]?.current?.ozone ?? null, co: airData[index]?.current?.carbon_monoxide ?? null, so2: airData[index]?.current?.sulphur_dioxide ?? null, modelDataTimestamp: airData[index]?.current?.time },
    weather: { temperature: weatherData[index]?.current?.temperature_2m, humidity: weatherData[index]?.current?.relative_humidity_2m, windSpeed: weatherData[index]?.current?.wind_speed_10m, windDirection: weatherData[index]?.current?.wind_direction_10m, precipitation: weatherData[index]?.current?.precipitation, pressure: weatherData[index]?.current?.surface_pressure, modelDataTimestamp: weatherData[index]?.current?.time }
  }));
}
