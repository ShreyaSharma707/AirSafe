import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { getDashboard } from './services/dashboardService.js';
import { simulateRisk } from './services/riskEngine.js';

const app = express();
const frontendOrigin = process.env.FRONTEND_ORIGIN;
const isProduction = process.env.NODE_ENV === 'production';
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (frontendOrigin) return callback(null, origin === frontendOrigin);
    if (!isProduction && /^https?:\/\/localhost(?::\d+)?$/.test(origin)) return callback(null, true);
    return callback(null, false);
  }
}));
app.use(express.json());
const frontendDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'dist');
let cache = null;
let cacheAt = 0;
let dashboardRequest = null;
const CACHE_MS = 10 * 60 * 1000;
const API_RATE_LIMITS = {
  read: { windowMs: 60 * 1000, max: 60 },
  impact: { windowMs: 60 * 1000, max: 30 }
};
const rateLimitBuckets = new Map();

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      rateLimitBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', Math.ceil((windowMs - (now - bucket.startedAt)) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please retry shortly.' });
    }
    return next();
  };
}

async function dashboard(forceRefresh = false) {
  if (!forceRefresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  if (!dashboardRequest) {
    dashboardRequest = getDashboard().then((fresh) => {
      cache = fresh;
      cacheAt = Date.now();
      return fresh;
    }).finally(() => {
      dashboardRequest = null;
    });
  }
  return dashboardRequest;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'AirSafe API' }));
app.get('/api/ready', async (_req, res, next) => {
  try {
    const data = await dashboard();
    const environmentZones = data.zones.filter((zone) => Number.isFinite(zone.air?.pm2_5) && Number.isFinite(zone.air?.pm10) && Number.isFinite(zone.weather?.windSpeed));
    const contextZones = data.zones.filter((zone) => zone.context?.complete === true);
    const riskZones = data.zones.filter((zone) => Number.isFinite(zone.risk?.score));
    const ready = environmentZones.length > 0 && contextZones.length > 0 && riskZones.length > 0;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      process: 'UP',
      environmentalData: environmentZones.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
      osmContext: contextZones.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
      zones: data.zones.length,
      completeContextZones: contextZones.length,
      riskableZones: riskZones.length,
      unavailableZones: data.zones.length - riskZones.length
    });
  } catch (error) { next(error); }
});
app.get('/api/zones', rateLimit(API_RATE_LIMITS.read), async (req, res, next) => { try { res.set('Cache-Control', 'no-store'); res.json(await dashboard(req.query.refresh === 'true')); } catch (error) { next(error); } });
app.get('/api/zones/:id', async (req, res, next) => { try { const data = await dashboard(); const zone = data.zones.find((item) => item.id === req.params.id); if (!zone) return res.status(404).json({ error: 'Zone not found' }); res.json(zone); } catch (error) { next(error); } });
const priorityZones = async (_req, res, next) => {
  try {
    const data = await dashboard();
    res.json(data.zones.filter((zone) => Number.isFinite(zone.risk?.score)).sort((a, b) => b.risk.score - a.risk.score).slice(0, 5));
  } catch (error) { next(error); }
};
app.get('/api/priority-zones', rateLimit(API_RATE_LIMITS.read), priorityZones);
app.get('/api/priority', rateLimit(API_RATE_LIMITS.read), priorityZones);
app.post('/api/impact', rateLimit(API_RATE_LIMITS.impact), async (req, res, next) => {
  try {
    const { zoneId, intervention = 'route' } = req.body;
    const factors = {
      school: { factor: .32, component: 'activityExposureProxy', eligible: false },
      hospital: { factor: .22, component: 'activityExposureProxy', eligible: false },
      roadExposure: { factor: .18, component: 'roadExposureProxy', eligible: false },
      route: { factor: .15, component: 'activityExposureProxy', eligible: false }
    };
    if (!Object.prototype.hasOwnProperty.call(factors, intervention)) {
      return res.status(400).json({ error: `Invalid intervention. Allowed values: ${Object.keys(factors).join(', ')}.` });
    }
    const zone = (await dashboard()).zones.find((item) => item.id === zoneId);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    if (!Number.isFinite(zone.risk?.score)) return res.status(503).json({ error: 'Impact simulation unavailable because zone risk is unavailable.' });
    factors.school.eligible = Number.isFinite(zone.context.activity) && zone.context.schools > 0;
    factors.roadExposure.eligible = Number.isFinite(zone.context.roadExposureProxy) && zone.context.roadExposureProxy > 50;
    factors.route.eligible = Number.isFinite(zone.context.activity);
    const scenario = factors[intervention];
    const simulatedRisk = scenario.eligible ? simulateRisk(zone.air, zone.context, zone.weather, scenario.component, scenario.factor) : null;
    const after = simulatedRisk?.score ?? zone.risk.score;
    const scoreReductionPoints = scenario.eligible ? Math.max(0, zone.risk.score - after) : 0;
    const explanation = scenario.eligible
      ? `Rule-based scenario estimate reducing the ${scenario.component} by ${Math.round(scenario.factor * 100)}% and recalculating the complete weighted risk score. This is not a PM2.5 reduction.`
      : intervention === 'hospital'
        ? 'This hospital scenario is unavailable because mapped hospitals do not directly measure the school-derived activity exposure proxy.'
        : 'This scenario is not eligible because no matching mapped context was found in this zone.';
    res.json({ before: zone.risk.score, after, scoreReductionPoints, eligible: scenario.eligible, label: 'Estimated / simulated exposure-score impact', explanation });
  } catch (error) { next(error); }
});
app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'), (error) => error ? next() : undefined);
});
app.use((error, _req, res, _next) => { console.error(error); res.status(502).json({ error: 'Live environmental data is temporarily unavailable. Please retry shortly.' }); });
const port = process.env.PORT || 4000;
app.listen(port, '0.0.0.0', () => console.log(`AirSafe API listening on ${port}`));
