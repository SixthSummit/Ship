/** Contract tests for the <%= name %> identity-provider boundary. */
import { runConformance } from '@sixthsummit/ship-angular/testing';
import { <%= name %> } from './<%= fileName %>';

runConformance(() => new <%= name %>());
