import { type OperationActor, operationActor } from "@sixthsummit/ship-core";
import type { HonoAuthenticationOptions } from "@sixthsummit/ship-hono";
import {
  type FirebaseCredential,
  type FirebaseTokenVerifier,
  firebaseActorResolver,
  firebaseAuthentication,
  firebaseBearerCredentials,
} from "./index.js";

declare const verifier: FirebaseTokenVerifier;

const credentials = firebaseBearerCredentials();
const actors = firebaseActorResolver({
  verifier,
  resolveActor: ({ uid, operation }): OperationActor | null =>
    operation.access.kind === "public"
      ? operationActor({ id: uid })
      : operationActor({ id: uid, permissions: ["accounts:read"] }),
});
const authentication: HonoAuthenticationOptions<FirebaseCredential> = {
  credentials,
  actors,
};
const combined: HonoAuthenticationOptions<FirebaseCredential> = firebaseAuthentication({
  verifier,
  resolveActor: ({ uid }) => operationActor({ id: uid }),
});

void authentication;
void combined;

// @ts-expect-error application actor construction is mandatory
firebaseAuthentication({ verifier });
