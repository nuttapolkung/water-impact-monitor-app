# Water Impact Monitor

Thai water-station dashboard for Mae Klong, Ratchaburi, Samut Songkhram and surrounding waterways. GPS and manually selected locations find nearby real ThaiWater / RID measurements, with a Leaflet map and an explained **screening signal**, not a property-level flood forecast.

## Run locally

Requires Node.js 22 or 24. The only runtime dependency is the pinned ws WebSocket client. No API secrets are required.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. Localhost is a secure context for browser geolocation; remote access requires HTTPS.

```sh
npm run check
```

Tests cover the verified upstream schema, numeric nulls, station coordinates, water-status semantics, timezone handling, data age, rate calculations, cache failures, request coalescing, API validation/CORS/rate limiting, GPS outcomes and frontend failure states. Browser layout testing is separate from real-device GPS acceptance.

## Existing Render deployment

| Purpose                            | Service                    | URL                                           | Configuration                                                         |
| ---------------------------------- | -------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Public frontend                    | `water-impact-monitor`     | https://water-impact-monitor.onrender.com     | Static, main, `npm ci && npm run build:static`, publish `dist`        |
| API and optional combined frontend | `water-impact-monitor-app` | https://water-impact-monitor-app.onrender.com | Node, main, `npm install`, `npm start`, Singapore, existing free plan |

Both services are configured for auto-deploy, but the live push test did not trigger builds. Render shows no connected Git provider; reconnect GitHub for this repository before claiming push-based auto-deployment. Current releases were manually triggered and verified. `assets/config.js` points the canonical static hostname at the existing Node API. Other hosts use their own origin. This keeps the current public URL and requires no new service. The Node service also serves the frontend, so it can be used alone if hosting is later consolidated.

`npm install` / `npm ci` runs the checks through `postinstall`, so the existing Render Node build fails if they do not pass. A GitHub Actions template is provided in `docs/templates/github-actions-check.yml`; enabling that optional workflow requires GitHub authorization with the `workflow` scope. It is not enabled by this deployment.

`npm run build:static` copies only index.html and assets into the generated dist directory; the static service publishes that directory instead of the repository root.

Leaflet 1.9.4 JS/CSS are vendored with their license and verified against the official SHA-256 values. Map tiles use the standard OpenStreetMap service with visible attribution, normal browser caching, and a referrer. Change `tileUrl` in `assets/config.js` when a dedicated tile service is needed. Do not add tile prefetching or offline tile downloads.

The existing free Node service may sleep when idle, delaying the first API request by around a minute. The frontend displays a loading explanation and permits a 65-second request. A paid always-on service is a separate operating decision; no plan upgrade is applied here.

## API

```sh
curl 'http://localhost:3000/api/water?lat=13.518&lon=99.954&radius=50'
```

`lat`: -90..90, `lon`: -180..180, `radius`: 20, 50 or 100 km (default 50).

The response includes `updatedAt` (last successful source fetch), `checkedAt` (this dashboard request), `location`, `radiusKm`, normalized `stations`, `source`, `assessment` and contextual input status. Each station has its own `sensorUpdatedAt`, water-level datum, agency, status, bank gap, distance and data quality.

`GET /api/context?lat=13.518&lon=99.954&radius=50` returns independent rainfall and coastal tide context with the same coordinate/radius validation, CORS and rate limit. Rainfall loading does not block water readings, and water-provider failure does not block context. Rainfall includes the selected station, distance, measurement time, source fetch time and availability. Tide values include prediction time, MSL datum and the official PDF URL. Neither input currently enters the screening score.

Status codes: 200 for fresh or usable stale cache, 400 invalid parameters, 429 rate limit, 503 no usable source/cache. The 503 response retains the same structured dashboard envelope and never invents readings.

`GET /healthz` checks process readiness and includes `RENDER_GIT_COMMIT` when available. It deliberately does not claim upstream health; check `/api/water` and `source.status` too.

## Reliability and assessment

- National data is fetched at most once per 60 seconds per process, independent of user coordinates. Concurrent requests share a fetch.
- ThaiWater requests have an 8-second timeout, one retry, an 8 MiB body cap, content/schema validation and a 60-second retry backoff. HTTP 429 is not immediately retried: it respects `Retry-After` with at least 15 minutes of per-source cooldown. Access refusals are also not immediately retried.
- ThaiWater and RID are fetched independently, then combined and sorted by distance. A healthy ThaiWater feed must not hide nearby gates available only in RID. Per-source connection status, timestamps and incomplete coverage are returned by the API and displayed. RID has a 30-second connection/snapshot timeout and one attempt per refresh. Each national snapshot is shared across all users; no user coordinates go to either upstream.
- If the hosted API has no usable data, the page tries the public CORS-enabled ThaiWater endpoint, then the independent public RID WebSocket snapshot. When the API has ThaiWater but RID is missing or stale, a RID-only browser request supplements its gates, deduplicates gauge IDs and recomputes distance order. The browser route is disclosed in source details and uses the same normalization/screening modules. National snapshots are shared once per minute per page; RID connections close after INIT, abort or timeout. No coordinates or subscription messages are sent upstream; ThaiWater requests omit cookies. Requests/body sizes are bounded and cooldowns are independent per source. This route does not establish Render-to-provider connectivity.
- Last-known-good data survives upstream errors and is usable for up to six hours. Its original fetch timestamp is preserved. Separate source caches are written atomically to `.cache/water.json.0` and `.cache/water.json.1` when writable. Render's free disk is ephemeral, so cache persistence across deploys/restarts is not guaranteed.
- Only station readings at most three hours old, with a known status and MSL water level, enter screening. RID station-local values can enter only when verified warning and critical thresholds use that same local datum. Readings from a stale source are excluded even when another source is fresh; a wholly stale response disables the score. Station-local levels are displayed separately and never treated as mean sea level.
- ThaiWater levels **1/2 = low water, 3 = normal, 4 = high water, 5 = overflow**. This is not a monotonic flood-warning scale.
- RID warning/critical thresholds are kept separate from ThaiWater overflow/bank metadata. Critical RID readings are labeled "ถึงเกณฑ์วิกฤติ RID", never asserted to be measured flooding. Multiple gauge points at a gate are displayed separately so a high downstream reading is not hidden by a lower upstream reading.
- The rise-rate card automatically requests the nearest station's historical graph and averages the change over the actual near-one-hour measurement interval. It discloses the station and both measurement times. If graph comparison is unavailable, a rate from two distinct timestamped observations can be displayed. The upstream previous value without a timestamp never supplies an hourly rate. Only the observed service rate, where available, enters screening; the graph-based card rate is context.
- The screening score is a heuristic from water status, station bank gap, straight-line distance and a timestamped rise rate where available. Reasons prioritize the station driving the score. It is not calibrated probability, a geographic inundation model, or an official warning.
- Impact confidence remains low because user elevation, hydraulic connectivity, levees, drainage, tides, rainfall and flood history are not integrated into the score. Rain and coastal predictions appear separately as context. Missing input is visibly marked, never assumed safe.
- The nearest station immediately loads actual 1/3/6/24-hour history from the provider's public graph endpoint; other cards load when visible or explicitly requested. Deltas use the same gauge, datum and actual graph measurement timestamp; values within 15 minutes of the requested baseline are marked approximate, and gaps stay missing. Rounded dashboard values are checked against the latest compatible graph reading before using its full precision. RID channels can update independently of their shared report timestamp; the UI uses and discloses each channel's own latest measured time. History requests share a five-minute per-station cache, at most two concurrent requests, and provider-wide throttling cooldowns; they send station IDs and dates, never GPS coordinates. A server restart does not require waiting 24 hours to build history.
- Rainfall uses ThaiWater's verified `rain_24h` feed. A national memory cache is shared for five minutes per process/page, with a ten-second timeout and 8 MiB body cap. HTTP 429/403 respects at least 15 minutes of cooldown or longer Retry-After. Other failures back off for a minute; usable cached data retains its original timestamp for at most six hours. The closest fresh gauge within the selected radius is preferred; readings older than three hours are disclosed as stale and older than six hours are omitted. Measured zero remains zero; missing data never becomes zero. Browser fallback omits cookies and coordinates. The card is a nearby gauge's 24-hour accumulation, not rainfall measured at the selected point.
- When ThaiWater rain is unavailable, stale or lacks a nearby gauge, browser RID supplementation uses the verified completed 07:00-to-07:00 accumulation (`rain_sum.value[0]`). The card separates the period end from the latest source report time; rain since today's 07:00 is not mislabeled as 24 hours. Water and rain share one bounded national RID snapshot per minute, with a one-minute failure cooldown. Cached source fetch timestamps are preserved in both consumers; no extra per-user socket or GPS transmission is added. The source link changes to RID when it supplies the displayed rain.
- Tide context uses the Navy's 2026 hourly MSL predictions for Pak Nam Mae Klong and Pak Nam Tha Chin. The closest coastal reference within 100 km is shown with its distance, exact table hour in Thailand time and the maximum of the next 24 hourly entries. No interpolation, live-sensor claim or hydraulic propagation to the selected point is inferred. Missing years or incomplete future windows remain unavailable. Predictions do not enter screening.
- Water-route disclosures provide documented regional river origins or canal connections, with primary-source links. Station codes and coordinates, or explicit river metadata within the documented lower basin, identify routes. Basin membership and nearest stations alone do not establish a connection. Unknown routes are labeled; gates/tides can change actual direction, and these diagrams do not feed the impact score or predict water arrival. See `docs/SOURCES.md` for coverage and evidence.
- API requests are limited to 90 per client address per minute per process; this is a lightweight single-instance limit, not a distributed abuse-control service.
- Application logs report upstream health and count, without GPS coordinates. The user's location is sent to this app's API only; infrastructure access logs and the map provider have their own policies.

## Operational verification

1. Check each Render deploy is `live` at the intended Git commit.
2. Check the static root and its `/assets/config.js` and `/assets/app.js` are current.
3. Check the Node `/healthz`, then `/api/water` and `/api/context` with a known regional reference point and the static site's `Origin` header.
4. Open the public site on a phone, grant Location, check accuracy and timestamps, and compare radius/map/list results. Test denied permission via manual fallback.
5. Compare a station reading and timestamp against its attributed official source. Do not interpret a successful deploy or mocked GPS test as user acceptance of a flood forecast.

Source verification and remaining integrations: [docs/SOURCES.md](docs/SOURCES.md). Original supplied handoff: [docs/HANDOFF.md](docs/HANDOFF.md).

## Tide-table maintenance

`assets/tide-tables-2026.js` contains 17,520 hourly predictions, source PDF URLs and SHA-256 checksums. It expires at the end of 2026; it never repeats an old year's table. The offline importer requires `pypdf` and the two official MSL PDFs, in Mae Klong / Tha Chin order:

```sh
python scripts/import-navy-tides.py MK2026mls.pdf TC2026msl.pdf
```

The importer verifies station names, coordinates, year, MSL datum, Thailand time and every calendar day/hour before replacing the dataset. It currently accepts only 2026. A new year requires updating the importer, source URLs, asset name/import and tests, and comparing extracted values against the rendered official tables. Python and PDFs are not runtime dependencies.
