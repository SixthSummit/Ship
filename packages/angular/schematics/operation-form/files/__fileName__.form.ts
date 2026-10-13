import { createOperationForm } from '@sixthsummit/ship-angular/forms';
import { <%= bindingName %> } from '<%= bindingPackage %>';

/** Each call owns independent controls, presence tracking, validation state, and teardown. */
export function create<%= name %>Form() {
  return createOperationForm(<%= bindingName %>);
}
