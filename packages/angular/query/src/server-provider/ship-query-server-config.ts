/** Fixed, non-secret identity for one Angular server request injector. */
export interface ShipQueryServerConfig {
  readonly namespace: string;
  readonly scopeKey: string;
}
