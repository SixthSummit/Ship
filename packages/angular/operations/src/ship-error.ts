interface ShipErrorBase {
  readonly message: string;
  readonly details?: unknown;
  readonly requestId?: string;
  /** Unknown additive fields retained from the server error object. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  /** Unknown additive fields retained from the outer response envelope. */
  readonly envelopeExtensions?: Readonly<Record<string, unknown>>;
}

/** An application failure whose code was declared by the selected operation. */
export interface DeclaredShipError<TCode extends string = string> extends ShipErrorBase {
  readonly declared: true;
  readonly code: TCode;
}

/** A well-formed application failure containing a code absent from the contract. */
export interface UnknownShipError extends ShipErrorBase {
  readonly declared: false;
  readonly code: string;
}

/** Application failure returned by an operation, including version-skew-safe codes. */
export type ShipError<TCode extends string = string> = DeclaredShipError<TCode> | UnknownShipError;
