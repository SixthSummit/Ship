---
"@sixthsummit/ship-angular": minor
---

Add the `/console` entrypoint for the ops console (SAPI-757): `provideShipConsole({ client, prefix? })`, the signal-first `ShipConsole` service over any structural operation client, `ShipConsoleContract` for a typed client, standalone `OnPush` panel components for jobs, cron, webhooks, realtime and outbox, `ShipConsoleShellComponent`, `shipConsoleRoutes({ canActivate })` for embedding under an application route, and `ShipConsoleAppComponent` for a console deployed next to the API.
