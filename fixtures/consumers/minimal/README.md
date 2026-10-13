# Minimal golden consumer

This fixture proves the shortest production-shaped Ship application using only
public package imports. The root golden-consumer runner copies it outside the
workspace, replaces Ship dependencies with freshly packed tarballs, records
their SHA-256 provenance, and runs the fixture's own checks.

The application includes a protected read, a transaction-scoped write, a real
PostgreSQL repository, generated Hono routes, and a typed HTTP client. Unit tests
use an in-memory unit-of-work substitute; the integration test uses the
published `@sixthsummit/ship-testing` PostgreSQL harness.
