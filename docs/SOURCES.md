# Source verification — 2 October 2026 (Asia/Bangkok)

## Integrated: ThaiWater telemetry

Structured endpoint: https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load

Live server-side request returned HTTP 200, JSON and 807 telemetry records during initial verification. A request with `Origin: https://water-impact-monitor.onrender.com` returned a matching `Access-Control-Allow-Origin`; the observed failure was not a reproduced CORS rejection. The old app instead omitted the actual coordinate fields.

Verified fields:

| Meaning | Response path |
| --- | --- |
| Telemetry rows | `waterlevel_data.data` with `result: OK` |
| Stable station ID/name | `station.id`, `station.tele_station_name.th` |
| Coordinates | `station.tele_station_lat`, `station.tele_station_long` |
| MSL level/previous value | `waterlevel_msl`, `waterlevel_msl_previous` |
| Station-local level | `waterlevel_m` (not interchangeable with MSL) |
| Sensor time | `waterlevel_datetime` (observed unzoned Thailand time) |
| Bank reference | `station.min_bank` |
| Situation | `situation_level`, with meanings in `scale.data.scale` |
| Ownership/context | `agency.agency_name`, `river_name`, `basin.basin_name`, `geocode.province_name` |

The live response and the [HII water-level page](https://tiwrmdev.hii.or.th/v3/telemetering/wl/warning) agree that level 3 is normal, 4 high and 5 overflow; levels 1/2 describe low water. [HII water data standards](https://standard.thaiwater.net/) describe data exchange and warning criteria.

The endpoint has no previous sensor timestamp alongside `waterlevel_msl_previous`, so a rate per hour cannot safely be calculated from that field alone. The app observes successive timestamped readings instead. Bank references are metadata for the sensor station, not the elevation or levee protecting a user's property.

Initial 50 km query around the clearly labeled Damnoen Saduak reference coordinate (13.518, 99.954) found 15 stations, including Ban Phaeo / MKG005 on Khlong Damnoen Saduak, Phra Ram 2 / MKG006, Photharam / RAJ001 and RID K.55A on the Mae Klong. Counts and readings vary with the upstream data and selected radius; coordinates are not a claim about the user's actual position.

## Candidate: Royal Irrigation Department

- [RID SWOC REST API documentation](https://swoc-api-service.rid.go.th/api/docs/) exposes water and rainfall endpoints including `/api/pier-tele-data/`, `/api/pier-hii-data/`, `/api/rainfall-hii-1hr/` and `/api/rainfall-hii-24hr/`.
- An unauthenticated call to `/api/pier-tele-data/` returned HTTP 401 with a missing-login message. It is not configured as a working failover source.
- [RID telemetry](https://telerid.rid.go.th/) and [RID hydromet](https://hydromet.rid.go.th/) are official public reference dashboards. Structured schemas, authorization, usage terms and independence from HII must be verified before wiring a fallback.
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

Physical iPhone/Android GPS permission, acquisition and accuracy still require testing on those devices. Browser viewport tests and mocked GPS-state tests do not prove this. Independent upstream failover, rain/tide/elevation integration and calibrated flood-impact prediction remain separate work.
