# Source verification — 2 October 2026 (Asia/Bangkok)

## Integrated: ThaiWater telemetry

Structured endpoint: https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load

Live server-side request returned HTTP 200, JSON and 807 telemetry records during initial verification. A request with `Origin: https://water-impact-monitor.onrender.com` returned a matching `Access-Control-Allow-Origin`; the observed failure was not a reproduced CORS rejection. The old app instead omitted the actual coordinate fields.

Verified fields:

| Meaning                  | Response path                                                                   |
| ------------------------ | ------------------------------------------------------------------------------- |
| Telemetry rows           | `waterlevel_data.data` with `result: OK`                                        |
| Stable station ID/name   | `station.id`, `station.tele_station_name.th`                                    |
| Coordinates              | `station.tele_station_lat`, `station.tele_station_long`                         |
| MSL level/previous value | `waterlevel_msl`, `waterlevel_msl_previous`                                     |
| Station-local level      | `waterlevel_m` (not interchangeable with MSL)                                   |
| Sensor time              | `waterlevel_datetime` (observed unzoned Thailand time)                          |
| Bank reference           | `station.min_bank`                                                              |
| Situation                | `situation_level`, with meanings in `scale.data.scale`                          |
| Ownership/context        | `agency.agency_name`, `river_name`, `basin.basin_name`, `geocode.province_name` |

The live response and the [HII water-level page](https://tiwrmdev.hii.or.th/v3/telemetering/wl/warning) agree that level 3 is normal, 4 high and 5 overflow; levels 1/2 describe low water. [HII water data standards](https://standard.thaiwater.net/) describe data exchange and warning criteria.

The endpoint has no previous sensor timestamp alongside `waterlevel_msl_previous`, so a rate per hour cannot safely be calculated from that field alone. The app observes successive timestamped readings instead. Bank references are metadata for the sensor station, not the elevation or levee protecting a user's property.

Initial 50 km query around the clearly labeled Damnoen Saduak reference coordinate (13.518, 99.954) found 15 stations, including Ban Phaeo / MKG005 on Khlong Damnoen Saduak, Phra Ram 2 / MKG006, Photharam / RAJ001 and RID K.55A on the Mae Klong. Counts and readings vary with the upstream data and selected radius; coordinates are not a claim about the user's actual position.

## Integrated fallback: Royal Irrigation Department

- [RID SWOC REST API documentation](https://swoc-api-service.rid.go.th/api/docs/) exposes water and rainfall endpoints including `/api/pier-tele-data/`, `/api/pier-hii-data/`, `/api/rainfall-hii-1hr/` and `/api/rainfall-hii-24hr/`.
- An unauthenticated call to `/api/pier-tele-data/` returned HTTP 401 with a missing-login message. It is not configured as a working failover source.
- The [RID telemetry dashboard](https://telerid.rid.go.th/) uses `wss://telerid.rid.go.th/ws/public/`. A public `INIT` snapshot was retrieved without credentials. It contained 921 station metadata entries; normalization retained 693 water gauge points with numeric readings and a known datum in the observed snapshot. Values and counts change.
- Verified schema: JSON envelope `message` contains a JSON string `{type: "INIT", data: {stationId: ...}}`; `location.x/y` are longitude/latitude, `measure.wl` selects water stations, `values.water_level_value_list.value` gives gauge readings, and `unixtime` is UTC Unix seconds. `cross_section[index]` matches the reading point and contains `parameter`, `unit`, `warning`, and `critical`. The official JS explicitly labels unit 0 as ม.รทก. and 1 as ม.รสม. Unknown units are omitted, not converted.
- Threshold classifications match the official dashboard comparison: at/above critical is critical, at/above warning is watch. Missing/inconsistent thresholds remain unknown. These are RID thresholds, not proof of overflowing banks.
- The independently served feed included Bang Nok Khwaek (TMK03), Wat Bang Khonthi Nai (TK.72), Bang Khonthi (TK.57), Ratchaburi and surrounding Mae Klong gauges. The observed 50 km Damnoen reference query found 17 gauge points. Upstream and downstream gauge readings at TMK03 remain distinct.
- A single bounded connection per shared server refresh reads INIT and closes. When the hosted feed is unavailable, each page can also share one browser snapshot per minute and close immediately. Neither route keeps per-user persistent sockets. [RID hydromet](https://hydromet.rid.go.th/) remains a public reference source.
- Some RID stations are already supplied through ThaiWater, with agency attribution preserved; this does not constitute an independent upstream.

## Candidate: rain and tide

- The RID REST documentation lists structured rainfall services, but authenticated access and response schema remain unverified. An early guessed ThaiWater `/rainfall24h` URL returned 404 and is not used.
- [Royal Thai Navy Hydrographic Department 2026 tide tables](https://hydro.navy.mi.th/waterlaveltable) provide authoritative station predictions, including separate reference datums. A published tide table is not a live sensor measurement at Damnoen Saduak, nor a validated local storm-surge forecast.
- Tide-station selection, datum compatibility, temporal interpolation and local hydraulic propagation must be resolved before using predictions in impact scoring.
- Current UI explicitly marks rain, tide and user elevation as unavailable and links the official reference sources. No inferred or invented readings enter the score.

## Map and emergency references

- [Leaflet official quick start](https://leafletjs.com/examples/quick-start/) supplies version 1.9.4 integrity hashes. Vendored assets match those hashes.
- [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/) requires attribution and normal caching/referrers; tiles have best-effort availability. The app uses only an actively viewed map and no bulk downloads.
- [DDPM warnings](https://disaster.go.th/contents/disaster_alert_report) and the [DDPM site](https://www.disaster.go.th/home) are linked when station observations indicate high water; 1784 is the published disaster-reporting hotline. The app does not claim to ingest official live warnings yet.

## Remaining evidence

Physical iPhone/Android GPS permission, acquisition and accuracy still require testing on those devices. Browser viewport tests and mocked GPS-state tests do not prove this. Rain/tide/elevation integration and calibrated flood-impact prediction remain separate work.

## Hosted upstream behavior

Render outbound requests to ThaiWater returned HTTP 429 on 2 October 2026 although local requests succeeded. The app respects throttling with per-source cooldown (at least 15 minutes or the longer Retry-After value), attempts the independent RID public feed, and clearly identifies the active source. It does not rotate proxies, invent readings or relabel a previous observation as live.

Hosted RID connections also timed out before their TLS/WebSocket handshake completed, with an explicit 30-second bound; local retrieval continued to succeed. The cause beyond this observed network failure is not established. Production-browser ThaiWater calls also returned HTTP 429 despite successful local command-line requests. The dashboard therefore has an explicitly labeled browser fallback through ThaiWater, then the independent public RID INIT snapshot, with shared normalization, a per-page one-minute cache, request/body bounds and independent backoff. No GPS coordinates or subscription messages are sent upstream. This browser route does not establish that the hosted proxy can retrieve live upstream data.

The official DWR listing also points to the Mae Klong JSON service at `https://tele-maeklong.dwr.go.th/webservice/webservice_mk_Json`. It returned records dated 23 August 2026 and zero-valued observations during the October check; it is not used as a fresh fallback.
