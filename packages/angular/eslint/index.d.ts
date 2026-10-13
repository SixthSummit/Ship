declare const plugin: {
  readonly meta: { readonly name: string };
  readonly rules: Readonly<Record<string, unknown>>;
};

export default plugin;
