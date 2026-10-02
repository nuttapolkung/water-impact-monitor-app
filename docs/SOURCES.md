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

## Historical water levels — verified 3 October 2026

- The official RID dashboard's station-detail code connects to `wss://telerid.rid.go.th/ws/station/<numeric ID>/`. Unlike the national INIT, its first JSON envelope contains `values.water_level_graph[index].time/value` arrays. Times are UTC Unix seconds, and the same indexed `cross_section` supplies the parameter and datum. Live retrieval of physical station 383 (TMK03) confirmed independent upstream/downstream channels; station 396 (TK.72) also provided a complete 24-hour comparison. Connections close after receipt or a ten-second timeout. The app fetches only visible cards, shares requests across gauges of one physical station, caches five minutes, and limits concurrency to two.
- The official [ThaiWater dashboard](https://www.thaiwater.net/) uses `/api/v1/thaiwater30/public/waterlevel_graph` with `station_type=tele_waterlevel`, `station_id`, `start_date`, and `end_date`. A live request for station 754 returned `result: OK`, `data.graph_data[].datetime/value`; its unzoned times are Bangkok local time and its axis is MSL. A 02:00 reading of 0.528 m matched the national feed's rounded 0.53 m. Matching CORS was observed from the production origin in a command-line request; upstream throttling may still prevent a browser request.
- Comparisons anchor to the station's actual latest measurement, not the page clock. They require an exact-time graph reading matching the published current value within rounding tolerance (0.0051 m), the same provider/station/channel/datum, and fresh current data. The graph's unrounded current value avoids false deltas caused by two-decimal dashboard rounding. Baselines use the nearest recorded sample within ±15 minutes, favoring the earlier sample on a tie. Approximate windows disclose actual timestamps/intervals. Missing samples, conflicting duplicates, invalid magnitudes (including ±32767 m), stale readings and mismatches do not produce numbers. No interpolation or cross-station substitution is used.
- Public historical graphs are fetched in the browser because Render-to-RID connectivity has timed out. Requests do not carry location or cookies. ThaiWater responses are capped at 1 MiB; RID at 8 MiB; graphs are capped at 5,000 samples and retained for 27 hours. HTTP 429/403 cool down the entire affected provider for at least 15 minutes or longer Retry-After. Failure results expire after a minute. No durable per-user history store or persistent socket is created.

## Documented water routes — verified 3 October 2026

These are geographic river origins and canal connections, not measurements of current flow, gate operation, discharge, flood propagation or arrival time. Routes remain independent of flood-impact scoring and a user's property.

Primary sources:

- [RID key-station registry](https://water.rid.go.th/hyd/download/key_station.pdf): station codes, coordinates and listed rivers. Checked Mae Klong codes include TK.72, TK.57/K.57, K.55A and K.2B; Tha Chin includes TTC09, TTC10 and T.1. A reused code outside a 2 km coordinate check is rejected. Code prefixes are not automatically removed; RID TK.2B is not blindly assigned the registry's different K.2B point.
- [Mae Klong diagram](https://water.rid.go.th/hyd/Diagram/graphic_maeklong.pdf), [Tha Chin diagram](https://water.rid.go.th/hyd/Diagram/graphic_thachin.pdf), and [Phetchaburi diagram](https://water.rid.go.th/hyd/Diagram/graphic_phetchaburi.pdf) from the [RID diagram catalog](https://water.rid.go.th/hyd/Diagram/graphic.html). These show the principal upstream branches, dams and river mouths. Explicit lower-basin river metadata can identify a documented main river; basin metadata alone cannot.
- [Ratchaburi National Museum / Fine Arts Department](https://www.finearts.go.th/ratchaburimuseum/view/21799): Damnoen Saduak Canal connects Mae Klong at Bang Nok Khwaek and Tha Chin at Bang Yang. TMK03 is the named Bang Nok Khwaek gate; ThaiWater MKG005 names the canal. The UI uses a bidirectional connection and explains that upstream/downstream labels identify gauge sides, not a measured direction right now.
- [RID Region 13 history](https://rid13.rid.go.th/th/history): canals and control structures on the east bank of Mae Klong include Bang Pa. Named mouth/middle Bang Pa gauges TK.75/TK.76 display this connection, with current incoming side explicitly unknown.

The curated code/coordinate mapping is in `assets/water-routes.js`. Coincident named gauges TK.55A/TTC08 and Phetchaburi TPB14/TPB15 use the matching official river diagram and station location. Unverified tributary/canal points, including TK.73, TK.71, TK.78 and TK.74, retain “origin not yet confirmed”; TK.74's broad registry river label does not resolve its local hydraulic path. This coverage is deliberately incomplete; nearby stations are never drawn as a hydraulic chain.

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
