// ship-angular/no-rxjs-in-public-api — public exports may not return Observable<T>.
//
// ShipAngular 4.0 is signal-first. Public APIs return Signal<T>, not Observable<T>.
// RxJS is permitted internally where it's the right tool, but never in the public surface.
//
// This rule fires on:
//   - Exported functions/methods/properties whose declared return type is `Observable<...>`
//     (or a transitive RxJS type like `Subject`, `BehaviorSubject`).
//   - Exported variables whose initializer is typed as one of the above.
//
// It runs against `**/public-api.ts` and any file matching `**/index.ts` inside
// packages/core/ or modules/* (the conventional re-export entry points).

const FORBIDDEN_TYPES = new Set([
  'Observable',
  'Subject',
  'BehaviorSubject',
  'ReplaySubject',
  'AsyncSubject',
]);

function isPublicApiFile(filename) {
  return /\/public-api\.ts$/.test(filename);
}

function getReturnTypeName(annotation) {
  if (!annotation) return null;
  if (annotation.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier') {
    return annotation.typeName.name;
  }
  if (annotation.type === 'TSUnionType') {
    for (const t of annotation.types) {
      const name = getReturnTypeName(t);
      if (name && FORBIDDEN_TYPES.has(name)) return name;
    }
  }
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Public exports of @sixthsummit/ship-angular may not return Observable<T>. Use Signal<T> or convert at the boundary.',
      recommended: true,
    },
    schema: [],
    messages: {
      forbidden:
        'Public exports cannot return `{{name}}<T>`. Convert to `Signal<T>` (use `toSignal()` if the internal source is RxJS).',
    },
  },

  create(context) {
    if (!isPublicApiFile(context.filename || context.getFilename())) {
      return {};
    }

    function checkAnnotation(node, annotation) {
      const name = getReturnTypeName(annotation && annotation.typeAnnotation);
      if (name && FORBIDDEN_TYPES.has(name)) {
        context.report({ node, messageId: 'forbidden', data: { name } });
      }
    }

    return {
      // Exported function declarations
      'ExportNamedDeclaration > FunctionDeclaration'(node) {
        checkAnnotation(node, node.returnType);
      },
      // Exported variable declarations whose annotation is RxJS
      'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator'(node) {
        if (node.id && node.id.typeAnnotation) {
          checkAnnotation(node, node.id.typeAnnotation);
        }
      },
      // Exported class methods/properties
      'ExportNamedDeclaration > ClassDeclaration > ClassBody > PropertyDefinition'(node) {
        if (node.accessibility === 'private' || node.accessibility === 'protected') return;
        if (node.typeAnnotation) {
          checkAnnotation(node, node.typeAnnotation);
        }
      },
      'ExportNamedDeclaration > ClassDeclaration > ClassBody > MethodDefinition'(node) {
        if (node.accessibility === 'private' || node.accessibility === 'protected') return;
        if (node.kind === 'constructor') return;
        if (node.value && node.value.returnType) {
          checkAnnotation(node, node.value.returnType);
        }
      },
    };
  },
};
