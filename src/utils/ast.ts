import generate from '@babel/generator';
import traverse, { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';

export function codePreview(node: t.Node) {
  const { code } = generate(node, { compact: true, comments: false });
  if (code.length > 100) {
    return code.slice(0, 70) + ' … ' + code.slice(-30);
  }
  return code;
}

/**
 * Recursively renames all references to the binding.
 * Make sure the binding name isn't shadowed anywhere!
 *
 * Example: `var alias = decoder; alias(1);` -> `decoder(1);`
 */
export function inlineVariableAliases(
  binding: Binding,
  targetName = binding.identifier.name
) {
  const refs = [...binding.referencePaths];
  const varName = m.capture(m.anyString());
  const matcher = m.or(
    m.variableDeclarator(
      m.identifier(varName),
      m.identifier(binding.identifier.name)
    ),
    m.assignmentExpression(
      '=',
      m.identifier(varName),
      m.identifier(binding.identifier.name)
    )
  );

  for (const ref of refs) {
    if (matcher.match(ref.parent)) {
      const varScope = ref.scope;
      const varBinding = varScope.getBinding(varName.current!);
      if (!varBinding) continue;

      // Check all further aliases (`var alias2 = alias;`)
      inlineVariableAliases(varBinding, targetName);

      if (ref.parentPath?.isAssignmentExpression()) {
        // Remove `var alias;` when the assignment happens separately
        varBinding.path.remove();

        if (t.isExpressionStatement(ref.parentPath.parentPath)) {
          // Remove `alias = decoder;`
          ref.parentPath.remove();
        } else {
          // Replace `(alias = decoder)(1);` with `decoder(1);`
          ref.parentPath.replaceWith(ref.parentPath.node.right);
        }
      } else if (ref.parentPath?.isVariableDeclarator()) {
        // Remove `alias = decoder;` of declarator
        ref.parentPath!.remove();
      }
    } else {
      // Rename the reference
      ref.replaceWith(t.identifier(targetName));
    }
  }

  // Have to crawl again because renaming messed up the references
}

/**
 * Example:
 * `function alias(a, b) { return decode(b - 938, a); alias(1071, 1077);`
 * ->
 * `decode(1077 - 938, 1071)`
 */
export function inlineFunctionAliases(binding: Binding) {
  const refs = [...binding.referencePaths];
  for (const ref of refs) {
    const fn = ref.findParent(p =>
      p.isFunctionDeclaration()
    ) as NodePath<t.FunctionDeclaration> | null;

    // E.g. alias
    const fnName = m.capture(m.anyString());
    // E.g. decode(b - 938, a)
    const returnedCall = m.capture(
      m.callExpression(m.identifier(binding.identifier.name))
    );
    const matcher = m.functionDeclaration(
      m.identifier(fnName),
      m.anything(),
      m.blockStatement([m.returnStatement(returnedCall)])
    );

    if (fn && matcher.match(fn.node)) {
      const fnBinding = fn.scope.parent.getBinding(fnName.current!);
      if (!fnBinding) continue;
      // Check all further aliases (`function alias2(a, b) { return alias(a - 1, b + 3); }`)
      const fnRefs = fnBinding.referencePaths;
      refs.push(...fnRefs);

      // E.g. [alias(1071, 1077), alias(1, 2)]
      const callRefs = fnRefs
        .filter(ref => ref.parentPath?.isCallExpression())
        .map(ref => ref.parentPath!) as NodePath<t.CallExpression>[];

      for (const callRef of callRefs) {
        const fnClone = t.cloneNode(fn.node, true);

        // Inline all arguments
        traverse(fnClone.body, {
          Identifier(path) {
            const paramIndex = fnClone.params.findIndex(
              p => (p as t.Identifier).name === path.node.name
            );
            if (paramIndex !== -1) {
              path.replaceWith(callRef.node.arguments[paramIndex]);
              path.skip();
            }
          },
          noScope: true,
        });

        // Replace the alias call itself with the return value
        callRef.replaceWith(
          (fnClone.body.body[0] as t.ReturnStatement).argument!
        );
      }

      fn.remove();
    }
  }

  // Have to crawl again because renaming messed up the references
  binding.scope.crawl();
}
