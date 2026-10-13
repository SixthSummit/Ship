import { InjectionToken } from '@angular/core';
import type { ShipQueryContext } from './ship-query-context';

export const SHIP_QUERY_CONTEXT = new InjectionToken<ShipQueryContext>('ShipQueryContext');
