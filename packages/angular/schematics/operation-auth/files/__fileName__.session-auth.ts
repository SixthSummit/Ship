import type { AuthUser } from '@sixthsummit/ship-angular';
import {
  OperationSessionAuthAdapter,
  type OperationSessionAuthAdapterConfig,
  type SessionAuthOperationMap,
} from '@sixthsummit/ship-angular/auth';
import type { <%= contractType %> } from '<%= contractPackage %>';
import { injectAppShipClient } from '<%= apiImport %>';

const <%= name.toUpperCase() %>_SESSION_OPERATIONS = {
  me: { operation: '<%= meOperationId %>', input: () => ({}) },<% if (signInOperationId) { %>
  signIn: {
    operation: '<%= signInOperationId %>',
    input: ({ email, password }) => ({ body: { email, password } }),
  },<% } %><% if (registerOperationId) { %>
  register: {
    operation: '<%= registerOperationId %>',
    input: ({ email, password }) => ({ body: { email, password } }),
  },<% } %><% if (signOutOperationId) { %>
  signOut: { operation: '<%= signOutOperationId %>', input: () => ({}) },<% } %><% if (refreshOperationId) { %>
  refresh: { operation: '<%= refreshOperationId %>', input: () => ({}) },<% } %>
} satisfies SessionAuthOperationMap<<%= contractType %>>;

export type <%= name %>SessionAuthOptions = Omit<
  OperationSessionAuthAdapterConfig<<%= contractType %>>,
  'client' | 'operations'
>;

/** Call from an Angular injection context and provide an explicitly validated identity mapper. */
export function create<%= name %>SessionAuthAdapter(
  options: <%= name %>SessionAuthOptions
): OperationSessionAuthAdapter<<%= contractType %>> {
  return new OperationSessionAuthAdapter<<%= contractType %>>({
    ...options,
    client: injectAppShipClient(),
    operations: <%= name.toUpperCase() %>_SESSION_OPERATIONS,
  });
}

/** Useful annotation for application-owned decoders supplied through `options.mapUser`. */
export type <%= name %>SessionUserMapper = (value: unknown) => AuthUser;
