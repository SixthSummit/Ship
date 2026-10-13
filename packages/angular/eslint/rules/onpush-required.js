// ship-angular/onpush-required — every @Component must declare ChangeDetectionStrategy.OnPush.
//
// Bad:
//   @Component({ selector: 'app-foo', template: '...' })
//
// Good:
//   @Component({
//     selector: 'app-foo',
//     template: '...',
//     changeDetection: ChangeDetectionStrategy.OnPush,
//   })

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require ChangeDetectionStrategy.OnPush on every @Component. ShipAngular 4.0 is signal-first and zoneless; default change detection wastes work.',
      recommended: true,
    },
    schema: [],
    messages: {
      missingOnPush:
        '@Component must set `changeDetection: ChangeDetectionStrategy.OnPush`. Default change detection is forbidden in 4.0.',
      wrongStrategy:
        '@Component changeDetection must be `ChangeDetectionStrategy.OnPush`, found `ChangeDetectionStrategy.{{found}}`.',
    },
  },

  create(context) {
    return {
      Decorator(node) {
        if (
          !node.expression ||
          node.expression.type !== 'CallExpression' ||
          !node.expression.callee ||
          node.expression.callee.name !== 'Component'
        ) {
          return;
        }

        const arg = node.expression.arguments[0];
        if (!arg || arg.type !== 'ObjectExpression') {
          context.report({ node, messageId: 'missingOnPush' });
          return;
        }

        const cdProp = arg.properties.find(
          p =>
            p.type === 'Property' &&
            ((p.key.type === 'Identifier' && p.key.name === 'changeDetection') ||
              (p.key.type === 'Literal' && p.key.value === 'changeDetection'))
        );

        if (!cdProp) {
          context.report({ node: arg, messageId: 'missingOnPush' });
          return;
        }

        const value = cdProp.value;
        if (
          value.type === 'MemberExpression' &&
          value.property &&
          value.property.type === 'Identifier'
        ) {
          if (value.property.name !== 'OnPush') {
            context.report({
              node: cdProp,
              messageId: 'wrongStrategy',
              data: { found: value.property.name },
            });
          }
        } else {
          context.report({ node: cdProp, messageId: 'missingOnPush' });
        }
      },
    };
  },
};
