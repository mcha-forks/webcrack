import { expression, statement } from '@babel/template';
import { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { generate, renameFast } from '../../ast-utils';

// TODO: hoist re-exports to the top of the file (but retain order relative to imports)
// TODO: when it accesses module.exports, dont convert to esm
// TODO: side-effect import
// FIXME: remove unused require vars (when they were used for imports/exports)
// also store import/export metadata in the require var for easier management

/**
 * Example: `__webpack_require__(id)`
 */
interface RequireCall {
  path: NodePath<t.CallExpression>;
  moduleId: string;
}

/**
 * Example: `var foo = __webpack_require__(id);`
 */
interface RequireVar {
  binding: Binding;
  moduleId: string;
  imports: (
    | t.ImportSpecifier
    | t.ImportNamespaceSpecifier
    | t.ImportDefaultSpecifier
  )[];
  exports: (t.ExportSpecifier | t.ExportNamespaceSpecifier)[];
}

export class ImportExportManager {
  /**
   * All module ids that are imported
   */
  imports = new Set<string>();
  /**
   * Names of all exports
   */
  exports = new Set<string>();

  /**
   * All `var foo = __webpack_require__(id);` variable declarations
   */
  requireVars: RequireVar[] = [];
  /**
   * All `__webpack_require__(id)` calls
   */
  requireCalls: RequireCall[] = [];

  webpackRequire: Binding | undefined;

  private ast: t.File;

  constructor(ast: t.File, webpackRequireBinding: Binding | undefined) {
    this.ast = ast;
    this.webpackRequire = webpackRequireBinding;
    this.collectRequireCalls();
  }

  insertImportsAndExports() {
    // const property = m.capture(m.anyString());
    // const memberExpressionMatcher = m.memberExpression(
    //   m.identifier(),
    //   m.identifier(property),
    // );
    // const zeroSequenceMatcher = m.sequenceExpression([
    //   m.numericLiteral(0),
    //   m.memberExpression(m.identifier(), m.identifier(property)),
    // ]);

    this.requireVars.forEach((requireVar) => {
      // TODO: resolve module id to path
      const namedExports = t.exportNamedDeclaration(
        undefined,
        requireVar.exports.filter((node) => t.isExportSpecifier(node)),
        t.stringLiteral(requireVar.moduleId),
      );
      const namespaceExports = requireVar.exports
        .filter((node) => t.isExportNamespaceSpecifier(node))
        .map((node) =>
          t.exportNamedDeclaration(
            undefined,
            [node],
            t.stringLiteral(requireVar.moduleId),
          ),
        );
      if (namedExports.specifiers.length > 0) {
        requireVar.binding.path.parentPath!.insertAfter(namedExports);
      }
      requireVar.binding.path.parentPath!.insertAfter(namespaceExports);

      // FIXME: collect this information earlier
      if (requireVar.binding.references > 1) {
        requireVar.binding.path.parentPath!.insertAfter(
          statement`import * as ${requireVar.binding.identifier} from '${requireVar.moduleId}'`(),
        );
      }

      const namedImports = t.importDeclaration(
        [
          ...requireVar.imports.filter((node) =>
            t.isImportDefaultSpecifier(node),
          ),
          ...requireVar.imports.filter((node) => t.isImportSpecifier(node)),
        ],
        t.stringLiteral(requireVar.moduleId),
      );
      const namespaceImports = requireVar.imports
        .filter((node) => t.isImportNamespaceSpecifier(node))
        .map((node) =>
          t.importDeclaration([node], t.stringLiteral(requireVar.moduleId)),
        );

      if (namedImports.specifiers.length > 0) {
        requireVar.binding.path.parentPath!.insertAfter(namedImports);
      }
      requireVar.binding.path.parentPath!.insertAfter(namespaceImports);

      requireVar.binding.path.remove();
    });

    // TODO: hoist imports to the top of the file
    this.requireCalls.forEach(({ path, moduleId }) => {
      path.replaceWith(expression`require('${moduleId}')`());
    });
  }

  private collectImports() {
    const property = m.capture(m.anyString());
    const memberExpressionMatcher = m.memberExpression(
      m.identifier(),
      m.identifier(property),
    );
    const zeroSequenceMatcher = m.sequenceExpression([
      m.numericLiteral(0),
      m.memberExpression(m.identifier(), m.identifier(property)),
    ]);

    this.requireVars.forEach((requireVar) => {
      const { binding } = requireVar;
      const importedLocalNames = new Set<string>();
      const hasOnlyNamedImports =
        binding.references > 0 &&
        binding.referencePaths.every((ref) =>
          memberExpressionMatcher.match(ref.parent),
        );

      if (hasOnlyNamedImports) {
        binding.referencePaths.forEach((reference) => {
          memberExpressionMatcher.match(reference.parent); // to populate property.current
          const importedName = property.current!;
          const hasNameConflict = binding.referencePaths.some((ref) =>
            ref.scope.hasBinding(importedName),
          );
          const localName = hasNameConflict
            ? binding.path.scope.generateUid(importedName)
            : importedName;

          if (!importedLocalNames.has(localName)) {
            importedLocalNames.add(localName);

            this.addNamedImport(requireVar, localName, importedName);
          }

          if (zeroSequenceMatcher.match(reference.parentPath?.parent)) {
            reference.parentPath.parentPath!.replaceWith(
              t.identifier(localName),
            );
          } else {
            reference.parentPath!.replaceWith(t.identifier(localName));
          }
          if (!memberExpressionMatcher.match(reference.parent)) return;
        });
        binding.path.remove();
      } else {
        binding.referencePaths.forEach((reference) => {
          reference.replaceWith(t.identifier(binding.identifier.name));
        });
        this.addImportNamespace(requireVar);
      }
    });

    this.requireCalls.forEach(({ path, moduleId }) => {
      path.replaceWith(expression`require('${moduleId}')`());
    });
  }

  addExport(scope: Scope, exportName: string, value: t.Expression) {
    this.exports.add(exportName);

    const objectName = m.capture(m.anyString());
    const propertyName = m.capture(m.anyString());
    const memberExpressionMatcher = m.memberExpression(
      m.identifier(objectName),
      m.identifier(propertyName),
    );

    if (t.isIdentifier(value)) {
      const binding = scope.getBinding(value.name);
      if (!binding) return;
      const requireVar = this.findRequireVar(binding.path.node);

      if (requireVar) {
        this.addExportNamespace(requireVar, exportName);
      } else if (exportName === 'default' && binding.references === 1) {
        this.addExportDefault(binding);
      } else {
        this.addExportDeclaration(binding, exportName);
      }
    } else if (memberExpressionMatcher.match(value)) {
      const binding = scope.getBinding(objectName.current!);
      if (!binding) return;
      const requireVar = this.findRequireVar(binding.path.node);
      if (!requireVar) return;

      this.addExportFrom(requireVar, propertyName.current!, exportName);
    } else {
      t.addComment(
        this.ast.program,
        'inner',
        `webcrack:unexpected-export: ${exportName} = ${generate(value)}`,
        true,
      );
    }
  }

  /**
   * Find the `var <name> = __webpack_require__(<id>);` statement that belongs to a binding node
   */
  findRequireVar(node: t.Node) {
    return this.requireVars.find((v) => v.binding.path.node === node);
  }

  /**
   * @returns local name of the default import
   */
  addDefaultImport(requireVar: RequireVar) {
    const existingDefaultImport = requireVar.imports.find((node) =>
      t.isImportDefaultSpecifier(node),
    );
    if (existingDefaultImport) {
      return existingDefaultImport.local.name;
    } else {
      const localName = requireVar.binding.scope.generateUid('default');
      requireVar.imports.push(
        t.importDefaultSpecifier(t.identifier(localName)),
      );
      return localName;
    }
  }

  private addNamedImport(
    requireVar: RequireVar,
    localName: string,
    importedName: string,
  ) {
    requireVar.imports.push(
      t.importSpecifier(t.identifier(localName), t.identifier(importedName)),
    );
  }

  private addImportNamespace(requireVar: RequireVar) {
    requireVar.imports.push(
      t.importNamespaceSpecifier(
        t.identifier(requireVar.binding.identifier.name),
      ),
    );
  }

  /**
   * Example:
   * ```js
   * __webpack_require__.d(exports, { foo: () => lib.bar });
   * var lib = __webpack_require__("lib");
   * ```
   * to
   * ```js
   * export { bar as foo } from 'lib';
   * ```
   */
  private addExportFrom(
    requireVar: RequireVar,
    localName: string,
    exportName: string,
  ) {
    requireVar.exports.push(
      t.exportSpecifier(t.identifier(localName), t.identifier(exportName)),
    );
  }

  /**
   * Example:
   * ```js
   * __webpack_require__.d(exports, { counter: () => foo });
   * var foo = 1;
   * ```
   * to
   * ```js
   * export var counter = 1;
   * ```
   */
  private addExportDeclaration(binding: Binding, exportName: string) {
    const statementPath = binding.path.getStatementParent()!;
    const matcher = m.or(
      m.variableDeclaration(),
      m.classDeclaration(),
      m.functionDeclaration(),
      m.exportNamedDeclaration(),
    );
    if (!matcher.match(statementPath.node)) return;

    const isDeclarationExport =
      exportName !== 'default' &&
      statementPath.type !== 'ExportNamedDeclaration';

    if (isDeclarationExport) {
      // Example: export var counter = 1;
      renameFast(binding, exportName);
      statementPath.replaceWith(t.exportNamedDeclaration(statementPath.node));
    } else {
      // Example: export { foo as bar };
      const [path] = statementPath.insertAfter(
        statement`export { ${binding.identifier.name} as ${exportName} }`(),
      );
      binding.reference(path.get('specifiers.0.local') as NodePath);
    }
  }

  /**
   * Example:
   * ```js
   * __webpack_require__.d(exports, { default: () => foo });
   * var foo = 1;
   * ```
   * to
   * ```js
   * export default 1;
   * ```
   */
  private addExportDefault(binding: Binding) {
    const node = binding.path.node;
    const value =
      node.type === 'VariableDeclarator'
        ? node.init!
        : (node as t.ClassDeclaration | t.FunctionDeclaration);
    binding.path
      .getStatementParent()!
      .replaceWith(statement`export default ${value}`());
  }

  /**
   * Example:
   * ```js
   * __webpack_require__.d(exports, { foo: () => lib });
   * var lib = __webpack_require__("lib");
   * ```
   * to
   * ```js
   * export * as foo from 'lib';
   * ```
   */
  private addExportNamespace(requireVar: RequireVar, exportName: string) {
    requireVar.exports.push(
      t.exportNamespaceSpecifier(t.identifier(exportName)),
    );
  }

  /**
   * Finds all `__webpack_require__(id)` and `var foo = __webpack_require__(id);` calls
   */
  private collectRequireCalls() {
    const idArg = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
    const requireCall = m.callExpression(m.identifier('__webpack_require__'), [
      idArg,
    ]);

    const varName = m.capture(m.anyString());
    const requireVar = m.variableDeclaration(undefined, [
      m.variableDeclarator(m.identifier(varName), requireCall),
    ]);

    this.webpackRequire?.referencePaths.forEach((path) => {
      m.matchPath(requireCall, { idArg }, path.parentPath!, ({ idArg }) => {
        const moduleId = idArg.node.value.toString();
        this.imports.add(moduleId);
        this.requireCalls.push({
          moduleId,
          path: path.parentPath as NodePath<t.CallExpression>,
        });

        if (requireVar.match(path.parentPath!.parentPath?.parent)) {
          const binding = path.scope.getBinding(varName.current!)!;
          this.requireVars.push({
            moduleId,
            binding,
            imports: [],
            exports: [],
          });
        }
      });
    });
  }
}
