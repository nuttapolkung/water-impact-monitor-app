# PROJECT HANDOFF — Water Impact Monitor

## Objective
Build a production-ready responsive web app for Thailand that:

1. Gets the user's current GPS location.
2. Fetches real water-level sensor data.
3. Finds sensors/stations near the user's location.
4. Displays water conditions as an infographic dashboard.
5. Estimates whether the user's current location may be affected.
6. Auto-refreshes sensor information.
7. Works well on iPhone, Android, tablet, and desktop.

Primary target area:
Damnoen Saduak, Ratchaburi / Mae Klong / Samut Songkhram and surrounding waterways.

---

## Existing Repository

GitHub:
https://github.com/nuttapolkung/water-impact-monitor-app

Branch:
main

Current important files:
- index.html
- Read.me

NOTE:
GitHub connector previously had Contents write permission problems.
Direct commits may therefore need to be done from Codex/local Git.

---

## Current Deployment

Render Static Site:

https://water-impact-monitor.onrender.com

Render:
- Service: water-impact-monitor
- Type: Static Site
- Region/global CDN
- Auto deploy from GitHub main
- HTTPS enabled

An older Node Render service also exists:
water-impact-monitor-app.onrender.com

The static site is the one we want to continue using unless architecture changes.

---

## Existing UI

Current index.html contains a responsive infographic dashboard.

Features:
- Current-location button
- navigator.geolocation
- automatic location request on page load
- GPS coordinates + accuracy
- configurable station search radius:
  - 20 km
  - 50 km
  - 100 km
- nearest sensor
- water level
- trend
- station cards
- risk gauge 0–100
- responsive mobile UI
- automatic refresh

Risk labels:
- ยังไม่พบสัญญาณเสี่ยงสูง
- ควรเฝ้าระวัง
- มีโอกาสได้รับผลกระทบ
- มีโอกาสได้รับผลกระทบสูง

IMPORTANT:
Current risk score is only preliminary screening.
Do NOT present it as a reliable flood forecast.

---

## Data Source

Initial data source investigated:

ThaiWater / National Hydroinformatics Data Center.

Previous frontend endpoint used:

https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load

Current code attempts to obtain:
- station coordinates
- station name/code
- waterlevel_msl / waterlevel_m
- previous water level
- situation_level
- update datetime

IMPORTANT:
Verify this endpoint and response schema again.
Do not assume the endpoint/schema is stable.

---

## Major Problem To Solve Next

CORS / upstream reliability.

Current static HTML may attempt to call ThaiWater directly from the browser.

Production architecture should instead be:

Browser
   |
   | HTTPS
   v
Water Impact Monitor
   |
   | /api/water
   v
Server-side proxy
   |
   v
ThaiWater / RID / other official water APIs

Benefits:
- avoid CORS
- caching
- upstream failover
- schema normalization
- rate limiting
- monitoring

Since current Render service is static-only, decide between:

A. Add a separate backend service/API on Render.

or

B. Convert project into a small Node web service serving both frontend and /api/water.

Option B is likely simpler for this project.

---

## Desired API

GET /api/water?lat=13.x&lon=99.x&radius=50

Return normalized data:

{
  "updatedAt": "...",
  "location": {
    "lat": ...,
    "lon": ...
  },
  "stations": [
    {
      "id": "...",
      "name": "...",
      "lat": ...,
      "lon": ...,
      "distanceKm": ...,
      "waterLevelMsl": ...,
      "previousWaterLevelMsl": ...,
      "trend": "rising|falling|stable",
      "situation": "...",
      "sensorUpdatedAt": "...",
      "source": "ThaiWater"
    }
  ]
}

Cache upstream responses appropriately.
Frontend can poll our API every ~5 seconds, but do NOT imply that the physical sensor updates every 5 seconds.

---

## GPS Requirements

Must work on HTTPS.

Use:

navigator.geolocation.getCurrentPosition()

or preferably watchPosition() where appropriate.

Options:
- enableHighAccuracy: true
- sensible timeout
- maximumAge

Handle:
- permission denied
- position unavailable
- timeout
- unsupported browser

Show a clear UI state.

Fallback:
Allow user to select/manual-enter a location if GPS is unavailable.

Do NOT silently substitute an inaccurate IP-derived location for GPS.

---

## Impact Assessment — Important Upgrade

Current calculation mainly uses:
- station situation level
- distance from user

This is NOT sufficient for true flood-impact prediction.

Upgrade model to incorporate, where data is available:

1. User elevation
2. Station water elevation
3. River/canal topology
4. Upstream/downstream relationship
5. Flood banks / levees
6. rainfall
7. tidal level / storm surge
8. drainage conditions
9. historical flood levels
10. rate of water rise

For Damnoen Saduak / Mae Klong, tide influence may be particularly important.

UI should distinguish:

DATA
- actual sensor measurements

from

ASSESSMENT
- calculated risk

and

CONFIDENCE
- confidence/quality of the assessment

Example:

Current location
Risk: WATCH

เหตุผล:
• สถานี A ห่าง 4.2 กม.
• ระดับน้ำเพิ่ม +8 ซม./ชม.
• สถานีต้นน้ำอยู่ในระดับเฝ้าระวัง
• น้ำทะเลกำลังหนุน

Confidence: Medium

---

## Desired Infographic UI

Top hero:

🌊 Water Impact Monitor

[ CURRENT LOCATION ]

Risk gauge

0 ---------------- 100

"ตำแหน่งนี้ควรเฝ้าระวัง"

Then:

📍 Your location
📡 Nearest station
💧 Current level
📈 Rate of rise
🌊 Tide
🌧 Rainfall

Then station cards.

Then map:

USER
  ●

waterways

sensor ●
sensor ●
sensor ●

Use mobile-first responsive layout.

---

## Map

Add an interactive map.

Preferred:
Leaflet + OpenStreetMap
(or equivalent lightweight solution)

Display:
- user GPS
- sensor stations
- radius
- waterway context

Station markers should be colored:
green / yellow / orange / red

Click marker:
station details.

---

## Refresh

Frontend:
poll normalized API.

5-second UI refresh is acceptable.

But separately display:

"Sensor updated: 14:20"

and

"Dashboard checked: 14:20:05"

Never imply that sensor telemetry itself updates every 5 seconds.

---

## Production Reliability

Implement:
- API timeout
- retries
- stale cache
- graceful fallback
- last-known-good data
- upstream source status
- schema validation
- logging

If ThaiWater is unavailable:

"ข้อมูลต้นทางชั่วคราวไม่พร้อมใช้งาน"

and show cached data with timestamp.

---

## Research Needed

Identify and verify official/current sources for:

1. ThaiWater water-level telemetry
2. Royal Irrigation Department telemetry
3. Ratchaburi water stations
4. Samut Songkhram / Mae Klong stations
5. rainfall
6. tide data
7. station metadata/coordinates
8. warning/bank levels

Prefer official government or authoritative hydroinformatics sources.

Do not scrape unstable visual dashboards if a structured API exists.

---

## Safety / UX

Do not say:

"บ้านคุณจะไม่ท่วม"

based solely on nearby sensor data.

Prefer:

"จากข้อมูลที่มีอยู่ ยังไม่พบสัญญาณความเสี่ยงสูง"

Always show timestamp and data source.

During dangerous conditions display official emergency/warning information prominently.

---

## Immediate Codex Tasks

1. Clone:
   https://github.com/nuttapolkung/water-impact-monitor-app

2. Inspect current index.html.

3. Verify Render deployment.

4. Test GPS on mobile HTTPS.

5. Test ThaiWater request and identify CORS/schema issues.

6. Research authoritative sensor APIs.

7. Implement backend proxy/normalization.

8. Refactor frontend to consume /api/water.

9. Add interactive map.

10. Improve risk assessment and explicitly expose confidence/reasons.

11. Test responsive UI:
    - iPhone
    - Android
    - desktop

12. Push to main.

13. Verify Render auto deployment.

14. Smoke test production URL.

Production URL:
https://water-impact-monitor.onrender.com

Goal:
Deliver a working production URL where the user can open it on their phone, grant Location permission, and immediately see nearby water sensors plus a clearly explained impact/risk assessment.