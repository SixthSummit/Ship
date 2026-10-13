import { createOperationForm, type OperationFormBinding } from '@sixthsummit/ship-angular/forms';
import { createShipApiClientExecutor } from '@sixthsummit/ship-angular/ship-api';
import { createFixtureClient } from '@sixthsummit/ship-api-conformance-client';
import {
  accountFormBinding,
  clientContract,
  type FixtureContract,
} from '@sixthsummit/ship-api-conformance-contract';

const client = createFixtureClient({ baseUrl: 'https://example.test' });
createShipApiClientExecutor<FixtureContract>(clientContract, () => client);
const binding: OperationFormBinding<
  FixtureContract,
  'accounts.create',
  { name: string; note: string | null; enabled: boolean }
> = accountFormBinding;
const form = createOperationForm<
  FixtureContract,
  'accounts.create',
  { name: string; note: string | null; enabled: boolean }
>(binding);
client.call('accounts.create', { body: form.body() });
client.call('accounts.get', { params: { accountId: 'a' } });
// @ts-expect-error unknown operation
client.call('accounts.unknown', {});
// @ts-expect-error missing required name
client.call('accounts.create', { body: { enabled: false } });
// @ts-expect-error wrong input location
client.call('accounts.get', { body: { accountId: 'a' } });
// @ts-expect-error wrong primitive control
form.form.controls.enabled.setValue('false');
const result = await client.call('accounts.create', { body: { name: 'Ada' } });
if (result.ok) {
  const status: 201 = result.status;
  const name: string = result.data.name;
  void status;
  void name;
  // @ts-expect-error impossible success status
  const wrong: 204 = result.status;
  void wrong;
} else {
  // @ts-expect-error undeclared error code
  const wrong: 'MADE_UP_ERROR' = result.error.code;
  void wrong;
}
