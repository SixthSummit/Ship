import type {
  OperationDataOf,
  OperationOf,
  StreamOperationId,
} from '@sixthsummit/ship-angular/operations';

/**
 * Frame payload type for a stream operation.
 *
 * Generated ShipAPI contracts declare `stream.frame` directly. Older structural
 * stream contracts project `{ frame: Frame; terminal: Terminal }` from success
 * data; a bare data type is treated as a frame-only stream.
 */
export type StreamFrameOf<TContract extends object, TId extends StreamOperationId<TContract>> =
  OperationOf<TContract, TId> extends { readonly stream: { readonly frame: infer TFrame } }
    ? TFrame
    : OperationDataOf<TContract, TId> extends infer TData
      ? TData extends { readonly frame: infer TFrame }
        ? TFrame
        : TData
      : never;

/**
 * Terminal payload type for a stream operation.
 *
 * `undefined` when the contract declares no terminal payload.
 */
export type StreamTerminalOf<TContract extends object, TId extends StreamOperationId<TContract>> =
  OperationOf<TContract, TId> extends { readonly stream: { readonly terminal: infer TTerminal } }
    ? TTerminal
    : OperationDataOf<TContract, TId> extends { readonly terminal: infer TTerminal }
      ? TTerminal
      : undefined;
