import * as t from '@babel/types';
import { applyTransform, renameFast, renameParameters } from '../../ast-utils';
import { Module } from '../module';
import type { FunctionPath } from './common-matchers';
import { ImportExportManager } from './import-export-manager';
import { default as definePropertyGetters } from './runtime/define-property-getters';
import getDefaultExport from './runtime/get-default-export';
import global from './runtime/global';
import hasOwnProperty from './runtime/has-own-property';
import moduleDecorator from './runtime/module-decorator';
import namespaceObject from './runtime/namespace-object';
import varInjections from './var-injections';

export class WebpackModule extends Module {
  #importExportManager: ImportExportManager;
  // TODO: expose to public API
  #sourceType: 'commonjs' | 'esm' = 'commonjs';

  constructor(id: string, ast: FunctionPath, isEntry: boolean) {
    // TODO: refactor
    const file = t.file(t.program(ast.node.body.body));
    super(id, file, isEntry);

    this.removeTrailingComments();
    // The params are temporarily renamed to these special names to avoid
    // mixing them up with the global module/exports/require from Node.js
    renameParameters(ast, [
      '__webpack_module__',
      '__webpack_exports__',
      '__webpack_require__',
    ]);
    const moduleBinding = ast.scope.getBinding('__webpack_module__');
    const webpackRequireBinding = ast.scope.getBinding('__webpack_require__');
    const exportsBinding = ast.scope.getBinding('__webpack_exports__');

    applyTransform(file, varInjections);

    this.#importExportManager = new ImportExportManager(
      file,
      webpackRequireBinding,
    );
    applyTransform(file, global, webpackRequireBinding);
    applyTransform(file, hasOwnProperty, webpackRequireBinding);
    applyTransform(file, moduleDecorator, webpackRequireBinding);
    applyTransform(file, namespaceObject);
    applyTransform(file, getDefaultExport, this.#importExportManager);
    applyTransform(file, definePropertyGetters, this.#importExportManager);
    this.#importExportManager.insertImportsAndExports();

    // For CommonJS
    if (moduleBinding) renameFast(moduleBinding, 'module');
    if (exportsBinding) renameFast(exportsBinding, 'exports');

    // this.removeDefineESM();
    // // FIXME: some bundles don't define __esModule but still declare esm exports
    // // https://github.com/0xdevalias/chatgpt-source-watch/blob/main/orig/_next/static/chunks/167-121de668c4456907.js
    // if (this.#sourceType === 'esm') {
    //   this.convertExportsToESM();
    // }
  }

  /**
   * Remove /***\/ comments between modules (in webpack development builds)
   */
  private removeTrailingComments(): void {
    const lastNode = this.ast.program.body.at(-1);
    if (
      lastNode?.trailingComments &&
      lastNode.trailingComments.length >= 1 &&
      lastNode.trailingComments.at(-1)!.value === '*'
    ) {
      lastNode.trailingComments.pop();
    }
  }
}
