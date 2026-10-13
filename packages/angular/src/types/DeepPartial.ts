/**
 * Makes all properties of T optional recursively
 * Useful for update operations where any subset of fields can be provided
 */
export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;
