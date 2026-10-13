import { defineActorResolver } from "@sixthsummit/ship-core";
import {
  defineHonoCredentialAdapter,
  type HonoAuthenticationOptions,
  requestHeadersCredential,
} from "./auth.js";

const bearer = defineHonoCredentialAdapter({
  id: "http.bearer",
  extract: (request): { readonly token: string } | undefined => {
    const token = request.headers.get("authorization");
    return token ? { token } : undefined;
  },
});
const actors = defineActorResolver<{ readonly token: string }>({
  id: "auth.bearer",
  resolve: ({ credential }) => {
    credential?.token satisfies string | undefined;
    return { ok: true };
  },
});

const auth: HonoAuthenticationOptions<{ readonly token: string }> = {
  credentials: bearer,
  actors,
};

const invalidAuth: HonoAuthenticationOptions<{ readonly token: string }> = {
  // @ts-expect-error credential and actor resolver evidence types must agree
  credentials: requestHeadersCredential(),
  actors,
};

void auth;
void invalidAuth;
