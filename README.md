# New Project Design - Backend API

## Application Database

The database connection string is provided by the platform and available in the Squad Room project info. Use it with pgAdmin or DBeaver to inspect your schema locally.

## Web API

**WebApi URL:** https://webapi6a8590914960943b6a810926-production.up.railway.app

**Swagger API Tester URL:** https://webapi6a8590914960943b6a810926-production.up.railway.app/swagger

## Google APIs (Gemini, Maps, Speech-to-Text)

The backend can use Google API keys provided via environment variables (set on Railway): **GOOGLE_API_KEY** for the Gemini LLM, and **GOOGLE_MAPS_API_KEY** for Geocoding, Maps, Directions, Places, and Speech-to-Text (Google requires Gemini keys to be separate from other APIs). Check **GET /api/google/status** and **GET /api/google/health** to verify the keys are set and reachable.

<!-- [PLATFORM-PROXY] ADDED SECTION. StrAppers BE: README template in GitHubService.cs (next to the "Google APIs (Gemini, Maps, Speech-to-Text)" section). Emit only for proxy-enabled projects if the rollout is opt-in. -->
### Calling Google from your code (platform proxy)

Always call Google through `googleFetch(service, pathAndQuery, init)` from `Infra/googleGateway.js`. `service` is `gemini`, `maps` (Geocoding, Directions), `places` (Places API New) or `speech`. The path is the normal Google path, without the host and without a key.

When **GOOGLE_PROXY_BASE_URL** and **GOOGLE_PROXY_TOKEN** are set, calls go through the Skill-in platform proxy and no raw Google keys are provided. Otherwise calls go straight to Google with the keys above. `GET /api/google/status` shows which mode is active.

Every request to this backend gets a run id: send your own in the **X-Run-Id** header or read the one returned in the **X-Run-Id** response header. **GET /api/debug/runs/{runId}** lists every Google call made while serving that request.

## Recommended Tools

**Recommended SQL Editor tool (Free):** [pgAdmin](https://www.pgadmin.org/download/)

## Deployment

This backend is configured for Railway deployment using nixpacks.toml.
