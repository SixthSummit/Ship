// ship-angular/route-guard-or-public — every Route in a Routes array must either:
//   1. declare a `canActivate` (or `canMatch`/`canActivateChild`), OR
//   2. carry a `data: { public: true }` flag explicitly opting out.
//
// Catches the common bug of forgetting to guard a new authenticated route.
// Public marketing routes opt out explicitly so the omission is intentional, not accidental.
//
// Bad:
//   { path: 'dashboard', loadComponent: () => ... }
//
// Good:
//   { path: 'dashboard', canActivate: [authGuard], loadComponent: () => ... }
//   { path: 'home',      data: { public: true },   loadComponent: () => ... }

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Routes must declare a canActivate guard or `data: { public: true }`. Prevents shipping unguarded authenticated routes.',
      recommended: true,
    },
    schema: [],
    messages: {
      ungarded:
        'Route `{{path}}` is missing a guard. Add `canActivate: [...]` or `data: { public: true }` to mark it intentional.',
    },
  },

  create(context) {
    function hasServerRouteAnnotation(identifier) {
      const annotation = identifier.typeAnnotation?.typeAnnotation;
      const elementType = annotation?.type === 'TSArrayType' ? annotation.elementType : annotation;
      return (
        elementType?.type === 'TSTypeReference' &&
        elementType.typeName?.type === 'Identifier' &&
        elementType.typeName.name === 'ServerRoute'
      );
    }

    function inspectRouteObject(obj) {
      if (!obj || obj.type !== 'ObjectExpression') return;

      const props = obj.properties;
      const path = props.find(
        p =>
          p.type === 'Property' &&
          ((p.key.type === 'Identifier' && p.key.name === 'path') ||
            (p.key.type === 'Literal' && p.key.value === 'path'))
      );

      // Only inspect entries with a `path` field — children/parent layout entries without paths skip.
      if (!path) return;

      const hasGuard = props.some(
        p =>
          p.type === 'Property' &&
          p.key.type === 'Identifier' &&
          (p.key.name === 'canActivate' ||
            p.key.name === 'canActivateChild' ||
            p.key.name === 'canMatch' ||
            p.key.name === 'canLoad')
      );

      if (hasGuard) return;

      // Check `data: { public: true }`
      const dataProp = props.find(
        p => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'data'
      );
      if (dataProp && dataProp.value.type === 'ObjectExpression') {
        const publicFlag = dataProp.value.properties.find(
          p =>
            p.type === 'Property' &&
            p.key.type === 'Identifier' &&
            p.key.name === 'public' &&
            p.value.type === 'Literal' &&
            p.value.value === true
        );
        if (publicFlag) return;
      }

      // Children-only routes (path: '' with children) are layout shells; allow them.
      if (
        path.value &&
        path.value.type === 'Literal' &&
        path.value.value === '' &&
        props.some(
          p => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'children'
        )
      ) {
        return;
      }

      const pathStr =
        (path.value && path.value.type === 'Literal' && String(path.value.value)) || '<unknown>';
      context.report({
        node: obj,
        messageId: 'ungarded',
        data: { path: pathStr },
      });
    }

    function visitRoutesArray(arr) {
      if (!arr || arr.type !== 'ArrayExpression') return;
      for (const el of arr.elements) {
        if (!el) continue;
        if (el.type === 'ObjectExpression') {
          inspectRouteObject(el);
          // Recurse into children
          const children = el.properties.find(
            p => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'children'
          );
          if (children && children.value.type === 'ArrayExpression') {
            visitRoutesArray(children.value);
          }
        }
      }
    }

    return {
      VariableDeclarator(node) {
        // Cover both Angular's conventional `routes` export and named feature arrays.
        if (
          node.id &&
          node.id.type === 'Identifier' &&
          !hasServerRouteAnnotation(node.id) &&
          (node.id.name === 'routes' || /Routes$/.test(node.id.name)) &&
          node.init &&
          node.init.type === 'ArrayExpression'
        ) {
          visitRoutesArray(node.init);
        }
      },
    };
  },
};
