---
'@sixthsummit/ship-angular': patch
---

Wait for the gateway's `ship:unsubscribe` ack before closing the idle realtime link.

Unsubscribing the last live subscription used to emit `ship:unsubscribe` and close the
socket in the same turn. The transport flushes the event and the disconnect in one write,
and a Socket.IO server dispatches the event on the next tick and discards it once the
socket has gone — so the gateway never recorded that final unsubscribe. Subscription state
was already correct (a gateway drops a connection's subscriptions on disconnect), but any
server-side accounting or metrics that count explicit unsubscribes lost the last one.

The client now defers the idle close until the ack settles, bounded by `ackTimeoutMs`: a
silent gateway or an already-dropped link still closes. `unsubscribe()` remains synchronous
and returns `void`, `close()` (and so `DestroyRef`) releases immediately without waiting for
a pending ack, and server rendering is unchanged.
