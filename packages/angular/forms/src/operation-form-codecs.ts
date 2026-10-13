export interface OperationFormCodec<TControl, TWire> {
  readonly decode: (wire: TWire) => TControl;
  readonly encode: (control: TControl) => TWire;
}

export function identityOperationFormCodec<T>(): OperationFormCodec<T, T> {
  return { decode: value => value, encode: value => value };
}

export const isoDateOperationFormCodec: OperationFormCodec<Date, string> = {
  decode: wire => {
    const date = new Date(wire);
    if (Number.isNaN(date.getTime())) throw new RangeError('Invalid ISO date value');
    return date;
  },
  encode: value => {
    if (Number.isNaN(value.getTime())) throw new RangeError('Invalid Date control value');
    return value.toISOString();
  },
};

export const bigintStringOperationFormCodec: OperationFormCodec<bigint, string> = {
  decode: wire => BigInt(wire),
  encode: value => value.toString(10),
};
