# Changelog

All notable changes for A3 are documented here.

## 0.2.2 - 2026-04-05
- Added `A3/render.yaml` blueprint for stable two-service deployment (backend + static frontend) on Render.
- Expanded `A3/INSTALL` with step-by-step Render deployment wiring for `VITE_API_BASE` and `CORS_ORIGIN`.

## 0.2.1 - 2026-04-05
- Published a live public frontend URL in `A3/WEBSITE` for submission checks.
- Added active frontend/backend public endpoint details to `A3/INSTALL`.
- Documented that the current public URLs are tunnel-based and can expire.

## 0.2.0 - 2026-04-06
- Added live negotiation messaging support in frontend via Socket.IO.
- Added backend negotiation message serialization in `/negotiations` and `/negotiations/me` responses.
- Improved socket behavior to auto-join active negotiation room on connection.
- Removed stray `backend/index.js` file to avoid ambiguity with `src/server.js`.

## 0.1.0 - 2026-04-06
- Added A3 backend scaffold from A2 with Prisma schema, API routes, CORS config, and seeded sample data.
- Added A3 frontend React app with role-based routes and pages for regular, business, and admin users.
- Added deployment/setup documentation in `A3/INSTALL` and placeholder URL in `A3/WEBSITE`.
