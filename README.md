# New Project Design - Backend API

## Application Database

The database connection string is provided by the platform and available in the Squad Room project info. Use it with pgAdmin or DBeaver to inspect your schema locally.

**Swagger API Tester URL:** /swagger

## Google APIs (Gemini, Maps, Speech-to-Text)

The backend can use Google API keys provided via environment variables (set on Railway): **GOOGLE_API_KEY** for the Gemini LLM, and **GOOGLE_MAPS_API_KEY** for Geocoding, Maps, Directions, Places, and Speech-to-Text (Google requires Gemini keys to be separate from other APIs). Check **GET /api/google/status** and **GET /api/google/health** to verify the keys are set and reachable.

## Recommended Tools

**Recommended SQL Editor tool (Free):** [pgAdmin](https://www.pgadmin.org/download/)

## Deployment

This backend is configured for Railway deployment using nixpacks.toml.
