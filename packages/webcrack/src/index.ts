import { ParseResult, parse } from '@babel/parser';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import debug from 'debug';
import { join, normalize } from 'node:path';
import {
  applyTransform,
  applyTransformAsync,
  applyTransforms,
  generate,
} from './ast-utils';
import deobfuscate, {
  Sandbox,
  createBrowserSandbox,
  createNodeSandbox,
} from './deobfuscate';
import debugProtection from './deobfuscate/debug-protection';
import mergeObjectAssignments from './deobfuscate/merge-object-assignments';
import selfDefending from './deobfuscate/self-defending';
import varFunctions from './deobfuscate/var-functions';
import jsx from './transforms/jsx';
import jsxNew from './transforms/jsx-new';
import mangle from './transforms/mangle';
import { unminify } from './unminify';
import {
  blockStatements,
  sequence,
  splitVariableDeclarations,
} from './unminify/transforms';
import { Bundle, unpackAST } from './unpack';
import { isBrowser } from './utils/platform';

export { type Sandbox } from './deobfuscate';

export interface WebcrackResult {
  code: string;
  bundle: Bundle | undefined;
  /**
   * Save the deobufscated code and the extracted bundle to the given directory.
   * @param path Output directory
   */
  save(path: string): Promise<void>;
}

export interface Options {
  /**
   * Decompile react components to JSX.
   * @default true
   */
  jsx?: boolean;
  /**
   * Extract modules from the bundle.
   * @default true
   */
  unpack?: boolean;
  /**
   * Deobfuscate the code.
   * @default true
   */
  deobfuscate?: boolean;
  /**
   * Unminify the code. Required for some of the deobfuscate/unpack/jsx transforms.
   * @default true
   */
  unminify?: boolean;
  /**
   * Mangle variable names.
   * @default false
   */
  mangle?: boolean;
  /**
   * Assigns paths to modules based on the given matchers.
   * This will also rewrite `require()` calls to use the new paths.
   *
   * @example
   * ```js
   * m => ({
   *   './utils/color.js': m.regExpLiteral('^#([0-9a-f]{3}){1,2}$')
   * })
   * ```
   */
  mappings?: (
    m: typeof import('@codemod/matchers'),
  ) => Record<string, m.Matcher<unknown>>;
  /**
   * Function that executes a code expression and returns the result (typically from the obfuscator).
   */
  sandbox?: Sandbox;
  /**
   * @param progress Progress in percent (0-100)
   */
  onProgress?: (progress: number) => void;
}

function mergeOptions(options: Options): asserts options is Required<Options> {
  const mergedOptions: Required<Options> = {
    jsx: true,
    unminify: true,
    unpack: true,
    deobfuscate: true,
    mangle: false,
    mappings: () => ({}),
    onProgress: () => {},
    sandbox: isBrowser() ? createBrowserSandbox() : createNodeSandbox(),
    ...options,
  };
  Object.assign(options, mergedOptions);
}

export async function webcrack(
  code: string,
  options: Options = {},
): Promise<WebcrackResult> {
  mergeOptions(options);
  options.onProgress(0);

  if (isBrowser()) {
    debug.enable('webcrack:*');
  }

  const isBookmarklet = /^javascript:./.test(code);
  if (isBookmarklet) {
    code = decodeURIComponent(code.replace(/^javascript:/, ''));
  }

  let ast: ParseResult<t.File> = null!;
  let outputCode = '';
  let bundle: Bundle | undefined;

  const stages = [
    () => {
      return (ast = parse(code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        plugins: ['jsx'],
      }));
    },
    () => {
      return applyTransforms(
        ast,
        [blockStatements, sequence, splitVariableDeclarations, varFunctions],
        { name: 'prepare' },
      );
    },
    options.deobfuscate &&
      (() => applyTransformAsync(ast, deobfuscate, options.sandbox)),
    options.unminify &&
      (() => {
        applyTransform(ast, unminify);
      }),
    options.mangle && (() => applyTransform(ast, mangle)),
    // TODO: Also merge unminify visitor (breaks selfDefending/debugProtection atm)
    options.deobfuscate &&
      (() => {
        return applyTransforms(ast, [selfDefending, debugProtection], {
          noScope: true,
        });
      }),
    options.deobfuscate && (() => applyTransform(ast, mergeObjectAssignments)),
    options.unpack && (() => (bundle = unpackAST(ast, options.mappings(m)))),
    options.jsx && (() => applyTransforms(ast, [jsx, jsxNew])),
    () => (outputCode = generate(ast)),
  ].filter(Boolean) as (() => unknown)[];

  for (let i = 0; i < stages.length; i++) {
    await stages[i]();
    options.onProgress((100 / stages.length) * (i + 1));
  }

  return {
    code: outputCode,
    bundle,
    async save(path) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      path = normalize(path);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'deobfuscated.js'), outputCode, 'utf8');
      await bundle?.save(path);
    },
  };
}
