# AirSafe

AirSafe is a real-data environmental exposure intelligence dashboard for Delhi/NCR. It combines Open-Meteo/CAMS modeled current estimates with a transparent, rule-based exposure model so a user can see **where** risk is concentrated, **why** it is high, and **what** intervention is recommended.

## Run locally

```powershell
npm install
npm run dev
```

The Vite frontend runs on `http://localhost:5173` and proxies `/api` to the Express server on port `4000`.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│ React + Vite + Tailwind + Leaflet                              │
│ Dashboard · risk map · selected-zone details · impact simulator │
└───────────────────────────────┬─────────────────────────────────┘
                                │ REST /api
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Node.js + Express API (AWS EC2)                                │
│                                                                 │
│  Routes                                                        │
│  /api/health · /api/ready · /api/zones · /api/zones/:id       │
│  /api/priority · /api/priority-zones · /api/impact             │
│                                                                 │
│  Services                                                       │
│  Open-Meteo ingestion → zone processing → risk engine           │
│                       → intervention engine                    │
│                       → impact simulation                       │
└───────────────┬───────────────────────────────┬─────────────────┘
                │                               │
                ▼                               ▼
┌───────────────────────────┐       ┌─────────────────────────────┐
│ Open-Meteo APIs           │       │ AWS S3                      │
│ Air quality + weather     │       │ Historical JSON snapshots    │
│ Batched by zone centroids │       │ Optional via environment    │
└───────────────────────────┘       └─────────────────────────────┘
```

### Data flow

1. The backend batches the nine Delhi/NCR zone coordinates into Open-Meteo air-quality and weather requests.
2. The zone processor combines those estimates with zone context such as schools, hospitals, and a major-road infrastructure proxy. Vulnerability is not derived from OSM and remains a neutral modeling assumption.
3. The deterministic risk engine calculates an explainable 0–100 exposure score using pollution, an activity exposure proxy derived from mapped activity locations, the vulnerability assumption, the major-road infrastructure proxy, and a wind-dispersion proxy.
4. The intervention engine selects a context-specific recommendation and explains why it applies.
5. The API returns modeled current estimates, derived context, risk explanations, and simulated impact results to the dashboard.
6. When AWS S3 is configured, each refreshed dashboard snapshot is stored as historical JSON. Without S3 configuration, the application remains fully runnable locally using the in-memory cache.

### Deployment

- **Frontend:** Build with Vite and serve `frontend/dist`.
- **Backend:** Run the Express process on AWS EC2.
- **CORS:** Set `FRONTEND_ORIGIN` to the exact deployed frontend origin in production. Local development permits localhost origins when `NODE_ENV=development`.
- **API limits:** `/api/zones` and `/api/priority` (and the legacy `/api/priority-zones`) allow 60 requests per IP per minute; `/api/impact` allows 30 requests per IP per minute. `/api/health` and `/api/ready` are not rate-limited.
- **Historical storage:** Use an S3 bucket configured with `AWS_S3_BUCKET` and `AWS_REGION`; standard AWS credentials or an EC2 instance role provide access.
- **Local development:** Vite proxies `/api` requests to the local Express server.

## Data honesty

- Air-quality and weather values are current modeled estimates from Open-Meteo/CAMS at each zone centroid, not direct CPCB ground-station observations.
- The nine zones are explicit Delhi/NCR planning polygons, with Gurugram and Noida represented separately. They should not be interpreted as official administrative boundaries.
- Schools, hospitals, and the road-exposure proxy are derived from OpenStreetMap/Overpass when available. The proxy is a normalized planning metric using 8 points per mapped major-road feature; it is not a measured traffic index. If required context enrichment is unavailable, the API marks the affected risk calculation as unavailable rather than substituting neutral values. The only neutral assumption is vulnerability at 50/100.
- AirSafe does not use real-time traffic data. Mapped major-road infrastructure from OpenStreetMap is an infrastructure/exposure proxy; OSM way segmentation means it must not be interpreted as traffic volume or congestion.
- Vulnerability is not currently observed or derived by AirSafe. The risk engine uses a clearly labeled neutral assumption of **50/100**; this value must not be interpreted as a zone-specific measurement.
- Risk scores are deterministic estimates, not machine-learning predictions.
- Impact results are simulations, not measured pollution reductions. School interventions modify the activity exposure planning proxy; route interventions currently modify that same proxy; road interventions modify the mapped road infrastructure proxy; hospital interventions are unavailable because hospitals do not currently drive the school-derived activity proxy.
- The dashboard's PM2.5 summary is an unweighted average across the nine AirSafe zones, not a population-weighted Delhi average.

## Deployment shape

Run `npm run build` and start the Express process with `npm start`; it serves both the API and `frontend/dist`, including the React SPA fallback. On AWS, the same Node process can run on EC2. Each refreshed dashboard snapshot is written to S3 when `AWS_S3_BUCKET` and `AWS_REGION` (plus standard AWS credentials or an EC2 instance role) are set.
