// ship-angular/use-inject — services and components must use `inject()` for DI.
// Forbids constructor parameter properties / accessors as a DI mechanism.
//
// Bad:
//   constructor(private auth: AuthService) {}
//
// Good:
//   private auth = inject(AuthService);
//
// Constructors are still allowed for non-DI work (initial state, computed
// caching, etc.); only parameter properties / annotated parameters trip the rule.

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require inject() for DI in services and components; forbid constructor DI parameters.',
      recommended: true,
    },
    schema: [],
    messages: {
      useInject:
        'Use `inject({{name}})` instead of constructor DI. ShipAngular 4.0 conventions require inject().',
    },
  },

  create(context) {
    return {
      MethodDefinition(node) {
        if (node.kind !== 'constructor') return;
        if (!node.value || node.value.type !== 'FunctionExpression') return;

        for (const param of node.value.params) {
          // TS parameter property: `constructor(private foo: Foo)` — has accessibility/readonly modifiers.
          if (param.type === 'TSParameterProperty' || param.accessibility || param.readonly) {
            const inner = param.parameter || param;
            const name =
              (inner && inner.type === 'Identifier' && inner.name) ||
              (inner && inner.left && inner.left.name) ||
              'Service';
            context.report({
              node: param,
              messageId: 'useInject',
              data: { name },
            });
            continue;
          }

          // Plain parameter with a type annotation that looks like an Angular DI shape.
          // We don't fail every constructor parameter — only those that are clearly DI candidates
          // (have a typeAnnotation that's a TSTypeReference, no default value, and the param is a plain identifier).
          if (
            param.type === 'Identifier' &&
            param.typeAnnotation &&
            param.typeAnnotation.typeAnnotation &&
            param.typeAnnotation.typeAnnotation.type === 'TSTypeReference' &&
            !param.optional
          ) {
            // We only flag this when the constructor body is empty or trivial — that's the smoking
            // gun of a "constructor exists only for DI" pattern. A constructor with a real body that
            // happens to take a typed parameter isn't necessarily DI.
            const body = node.value.body && node.value.body.body;
            if (!body || body.length === 0) {
              const name = param.name || 'Service';
              context.report({
                node: param,
                messageId: 'useInject',
                data: { name },
              });
            }
          }
        }
      },
    };
  },
};
