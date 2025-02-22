import { parse } from '@babel/parser';
import traverse, { visitors } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { unpackBrowserify } from './browserify';
import { Bundle } from './bundle';
import { unpackWebpack } from './webpack';
import debug from 'debug';

export { Bundle } from './bundle';

export function unpack(
  code: string,
  mappings: Record<string, m.Matcher<unknown>> = {},
): Bundle | undefined {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  return unpackAST(ast, mappings);
}

export function unpackAST(
  ast: t.Node,
  mappings: Record<string, m.Matcher<unknown>> = {},
): Bundle | undefined {
  const options: { bundle: Bundle | undefined } = { bundle: undefined };
  const visitor = visitors.merge([
    unpackWebpack.visitor(options),
    unpackBrowserify.visitor(options),
  ]);
  traverse(ast, visitor, undefined, { changes: 0 });
  // TODO: applyTransforms(ast, [unpackWebpack, unpackBrowserify]) instead
  if (options.bundle) {
    options.bundle.applyMappings(mappings);
    options.bundle.applyTransforms();
    debug('webcrack:unpack')('Bundle:', options.bundle.type);
  }
  return options.bundle;
}
