import type { ActorResolver } from "@sixthsummit/ship-core";

const CREDENTIAL_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

export interface HonoCredentialAdapter<TCredential = unknown> {
  readonly id: string;
  extract(request: Request): TCredential | undefined | Promise<TCredential | undefined>;
}

export interface HonoAuthenticationOptions<TCredential = unknown> {
  readonly credentials: HonoCredentialAdapter<TCredential>;
  readonly actors: ActorResolver<TCredential>;
}

export type HeaderCredential = Readonly<Record<string, string>>;

export function defineHonoCredentialAdapter<TCredential>(
  adapter: HonoCredentialAdapter<TCredential>,
): HonoCredentialAdapter<TCredential> {
  if (typeof adapter?.id !== "string" || !CREDENTIAL_ADAPTER_ID_PATTERN.test(adapter.id)) {
    throw new TypeError(
      `credential adapter id must be a lowercase dot-separated identifier; received ${JSON.stringify(adapter.id)}`,
    );
  }
  if (typeof adapter.extract !== "function") {
    throw new TypeError("credential adapter must define extract(request)");
  }
  return Object.freeze({ ...adapter });
}

export function isHonoCredentialAdapter(value: unknown): value is HonoCredentialAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "string" &&
    CREDENTIAL_ADAPTER_ID_PATTERN.test(Reflect.get(value, "id")) &&
    typeof Reflect.get(value, "extract") === "function"
  );
}

export function requestHeadersCredential(): HonoCredentialAdapter<HeaderCredential> {
  return defineHonoCredentialAdapter({
    id: "http.headers",
    extract: (request) =>
      Object.freeze(
        Object.fromEntries(
          [...request.headers].map(([name, value]) => [name.toLowerCase(), value]),
        ),
      ),
  });
}
