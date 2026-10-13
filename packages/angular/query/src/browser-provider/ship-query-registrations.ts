import { InjectionToken } from '@angular/core';

/** Internal ownership marker shared by browser and SSR provider composition. Do not export publicly. */
export const SHIP_QUERY_REGISTRATIONS = new InjectionToken<readonly object[]>(
  'ShipQueryRegistrations'
);
