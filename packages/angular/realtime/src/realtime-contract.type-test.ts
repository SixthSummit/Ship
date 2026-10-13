import type { Signal } from '@angular/core';
import type {
  RealtimeChannelId,
  RealtimeManifest,
  RealtimePayloadOf,
  RealtimePresenceChannelId,
} from './realtime-contract';
import type {
  RealtimePresenceState,
  RealtimeSubscription,
  ShipRealtime,
} from './realtime-subscription';

interface Channels {
  readonly channels: {
    readonly 'account.updated': {
      readonly scope: 'actor';
      readonly payload: { readonly balance: number };
      readonly presence: false;
    };
    readonly 'room.messages': {
      readonly scope: 'resource';
      readonly payload: { readonly text: string };
      readonly presence: true;
    };
  };
}

declare const client: ShipRealtime<Channels>;

// Channel ids come from the contract.
const channel: RealtimeChannelId<Channels> = 'room.messages';
void channel;
// @ts-expect-error an undeclared channel is not subscribable
client.subscribe('ghost.channel', 'x');

// Presence-bearing channels are distinguishable at the type level.
const presenceChannel: RealtimePresenceChannelId<Channels> = 'room.messages';
void presenceChannel;
// @ts-expect-error account.updated declares presence: false
const notPresence: RealtimePresenceChannelId<Channels> = 'account.updated';
void notPresence;

// Payloads are inferred per channel.
const account = client.subscribe('account.updated', 'actor-1');
const balance: number | undefined = account.latest()?.balance;
void balance;
// @ts-expect-error the account payload has no text field
void account.latest()?.text;

const room = client.subscribe('room.messages', 'room-7');
const presence: Signal<RealtimePresenceState | undefined> = room.presence;
void presence;
// @ts-expect-error presence is absent on channels declared without it
void account.presence;

room.events(event => {
  const text: string = event.payload.text;
  void text;
  const seq: number = event.seq;
  void seq;
});

type RoomPayload = RealtimePayloadOf<Channels, 'room.messages'>;
const roomPayload: RoomPayload = { text: 'hello' };
void roomPayload;

type RoomSubscription = RealtimeSubscription<Channels, 'room.messages'>;
declare const roomSubscription: RoomSubscription;
void roomSubscription.presence;

// The runtime manifest is keyed by the same channel ids.
const manifest: RealtimeManifest<Channels> = {
  channels: {
    'account.updated': { scope: 'actor', payload: 'AccountUpdated', presence: false },
    'room.messages': { scope: 'resource', payload: 'RoomMessage', presence: true },
  },
  operations: { 'rooms.post': { publishes: ['room.messages'] } },
};
void manifest;
