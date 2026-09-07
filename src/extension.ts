import * as vscode from 'vscode';
// TypeScript 7 is the Go rewrite and ships no JavaScript compiler API — the
// `typescript` package at 7.x exports only `version`. The parser below needs
// `createSourceFile`, so the API comes from 5.x under an alias while
// `typescript` (7.x, devDep) compiles this extension. Collapse the two once the
// 7.1 Compiler API lands.
import * as ts from 'typescript-api';
import * as path from 'path';

interface ImportGroup {
  key: string;
  label: string;
  /**
   * Claimed straight from the module path, before the remaining `src/` imports
   * are split into types and values. Order within GROUPS is the pass order.
   */
  fromPath?: boolean;
  /** Omitted on `types` and `other` — dedicated logic fills those buckets. */
  match?: (p: string) => boolean;
}

// Group order here is both the pass order and the output order.
const GROUPS: ImportGroup[] = [
  { key: 'next', label: 'Next', fromPath: true, match: (p) => p.startsWith('next/') },
  { key: 'react', label: 'React', fromPath: true, match: (p) => p === 'react' },
  { key: 'mui', label: 'MUI', fromPath: true, match: (p) => p.startsWith('@mui/') },
  {
    key: 'thirdparty',
    label: 'Third Party',
    fromPath: true,
    match: (p) => !p.startsWith('src/') && p !== 'react' && !p.startsWith('next/') && !p.startsWith('@mui/'),
  },
  { key: 'types', label: 'Types' },
  { key: 'reduxstore', label: 'Redux Store', match: (p) => p.startsWith('src/store/') },
  { key: 'api', label: 'API', match: (p) => p.startsWith('src/api-clients/') },
  { key: 'hooks', label: 'Hooks', match: (p) => p.includes('/hooks') },
  { key: 'config', label: 'Config', fromPath: true, match: (p) => p.startsWith('src/configs') },
  {
    key: 'local',
    label: 'Local',
    match: (p) =>
      p.startsWith('src/') &&
      !p.startsWith('src/store/') &&
      !p.startsWith('src/api-clients/') &&
      !p.startsWith('src/configs') &&
      !p.includes('/hooks') &&
      !p.includes('/utils'),
  },
  { key: 'utils', label: 'Utils', match: (p) => p.includes('/utils') },
  { key: 'other', label: 'Other' },
];

// Type aliases and style helpers exported from the MUI theme. They live in
// @mui/material/styles rather than becoming per-component default imports.
const MUI_STYLE_TOKENS = [
  'Direction',
  'Theme',
  'SxProps',
  'useTheme',
  'styled',
  'PaletteMode',
  'Palette',
  'PaletteOptions',
  'PaletteColor',
  'PaletteColorOptions',
  'ThemeOptions',
  'Breakpoint',
];

/** A single `{ ... }` entry of an import clause. */
interface NamedBinding {
  /** Local binding name — `B` in `{ A as B }`. */
  localName: string;
  /** Exported name — `A` in `{ A as B }`. */
  propertyName?: string;
  isTypeOnly: boolean;
  /** Offset of `localName` relative to the start of the import statement. */
  nameOffset: number;
}

/**
 * An `import ... from '...'` statement with a binding clause.
 *
 * Offsets index into the snapshot the statement was parsed from. Nothing in the
 * pipeline mutates the document, so they stay valid for hover requests.
 */
interface ParsedImport {
  start: number;
  end: number;
  text: string;
  moduleSpecifier: string;
  isTypeOnly: boolean;
  defaultName?: string;
  defaultNameOffset?: number;
  namespaceName?: string;
  named: NamedBinding[];
}

interface ParsedModule {
  imports: ParsedImport[];
  /**
   * Top-level statements that are not rewritable imports — side-effect imports,
   * re-exports, anything else. Tracked so statements between the first and last
   * import are preserved rather than swallowed by the replacement range.
   */
  otherStatements: { start: number; end: number }[];
  /** Identifiers referenced outside the import declarations. */
  referencedNames: Set<string>;
  hasJsx: boolean;
}

interface ImportEntry {
  /** Rendered statement with the module path already made absolute. */
  converted: string;
  /** The module path as it appears in `converted`. Derived once at construction. */
  modulePath: string;
  source: ParsedImport;
}

/**
 * Print style for generated lines, matched to the project's formatter so saving
 * does not reflow what this extension just wrote.
 */
interface OutputStyle {
  quote: string;
  semicolons: boolean;
  trailingComma: boolean;
  printWidth: number;
}

interface FormatterConfig {
  printWidth?: number;
  semi?: boolean;
  singleQuote?: boolean;
  trailingComma?: string;
}

const DEFAULT_PRINT_WIDTH = 120;

// oxfmt and Prettier share these option names, so one reader covers both.
const FORMATTER_CONFIG_FILES = [
  '.oxfmtrc.json',
  'oxfmt.config.json',
  '.oxfmtrc',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.jsonc',
];

function stripJsonComments(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.startsWith('"') ? match : ''
  );
}

/** The folder that owns this file; `workspaceFolders[0]` is the wrong root in a multi-root workspace. */
function workspaceFolderFor(document: vscode.TextDocument): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
}

/** Reads a JSON(C) file from the workspace root. Missing or malformed yields undefined. */
async function readWorkspaceJson(document: vscode.TextDocument, fileName: string): Promise<any> {
  const folder = workspaceFolderFor(document);
  if (!folder) return undefined;

  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, fileName));
    return JSON.parse(stripJsonComments(Buffer.from(raw).toString('utf8')));
  } catch {
    return undefined;
  }
}

/** Reads the project's formatter config. Anything unreadable is ignored. */
async function readFormatterConfig(document: vscode.TextDocument): Promise<FormatterConfig> {
  for (const fileName of FORMATTER_CONFIG_FILES) {
    const parsed = await readWorkspaceJson(document, fileName);
    if (parsed && typeof parsed === 'object') return parsed as FormatterConfig;
  }

  return {};
}

/** The project's `compilerOptions.jsx`, used to tell the two JSX runtimes apart. */
async function readJsxMode(document: vscode.TextDocument): Promise<string | undefined> {
  const jsx = (await readWorkspaceJson(document, 'tsconfig.json'))?.compilerOptions?.jsx;
  return typeof jsx === 'string' ? jsx : undefined;
}

/** Formatter config wins; anything it omits is inferred from the file. */
async function resolveStyle(document: vscode.TextDocument, imports: ParsedImport[]): Promise<OutputStyle> {
  const config = await readFormatterConfig(document);

  const doubleQuoted = imports.filter((imp) => /from\s*"/.test(imp.text)).length;
  const semicolonCount = imports.filter((imp) => imp.text.trimEnd().endsWith(';')).length;
  const multiLine = imports.filter((imp) => imp.text.includes('\n'));

  const inferredQuote = doubleQuoted * 2 > imports.length ? '"' : "'";
  const quote = typeof config.singleQuote === 'boolean' ? (config.singleQuote ? "'" : '"') : inferredQuote;

  return {
    quote,
    printWidth: config.printWidth ?? DEFAULT_PRINT_WIDTH,
    semicolons: typeof config.semi === 'boolean' ? config.semi : semicolonCount * 2 >= imports.length,
    trailingComma: config.trailingComma
      ? config.trailingComma !== 'none'
      : !multiLine.length || multiLine.some((imp) => /,\s*\n\s*\}/.test(imp.text)),
  };
}

// A symbol is a type only if the hover says interface, type alias, or enum.
// Order is irrelevant — any match wins.
const TYPE_HOVER_PATTERNS = [
  /\binterface\b\s+\w+|\(interface\)/i,
  /\btype\b\s+\w+|\(type alias\)|\(type\)|\(alias\)\s*type\b/i,
  /\benum\b\s+\w+|\(enum\)/i,
];

/**
 * Whether the symbol at a position is a type rather than a value.
 *
 * An extension cannot reach the type checker, so this scrapes the markdown the
 * language service renders for hover. Anything not clearly a type is treated as
 * a value, which is also what happens when the hover request fails or the server
 * has nothing to say.
 */
async function isTypeSymbol(document: vscode.TextDocument, position: vscode.Position): Promise<boolean> {
  try {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      position
    );
    if (!hovers?.length) return false;

    const hoverContent = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : c.value))
      .join('\n');

    return TYPE_HOVER_PATTERNS.some((pattern) => pattern.test(hoverContent));
  } catch (error) {
    // Silent error - no need to disrupt user experience
    return false;
  }
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.m?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * True when an identifier can only ever be a member name, never a reference to a
 * module binding — `api.updateForm`, the key in `{ updateForm: x }`, and so on.
 *
 * Only definitively-not-a-reference positions belong here. Missing one leaves an
 * unused import in place; wrongly adding one deletes a used import. Shorthand
 * (`{ updateForm }`) is absent on purpose — that is a real reference.
 */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;

  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }

  if (ts.isJsxAttribute(parent) && parent.name === node) return true;

  // The source key in `const { updateForm: renamed } = api`
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;

  // The alias in `export { updateForm as renamed }` — the source name still counts
  if (ts.isExportSpecifier(parent) && parent.propertyName && parent.name === node) return true;

  return false;
}

/**
 * Parses the top-level import statements out of a source text.
 *
 * Uses the bundled TypeScript parser rather than a regex: a regex cannot tell an
 * import from an `import(...)` inside a string, silently drops side-effect
 * imports, and gives no reliable offsets. The parser is this extension's own
 * dependency, so it behaves identically whichever language service the editor
 * happens to be running.
 */
function parseModule(text: string, fileName: string): ParsedModule {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));

  const imports: ParsedImport[] = [];
  const otherStatements: { start: number; end: number }[] = [];

  const referencedNames = new Set<string>();
  let hasJsx = false;
  const collectReferences = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;
    if (ts.isIdentifier(node) && !isMemberName(node)) referencedNames.add(node.text);
    node.forEachChild(collectReferences);
  };
  sourceFile.forEachChild(collectReferences);

  for (const statement of sourceFile.statements) {
    const start = statement.getStart(sourceFile);
    const end = statement.end;

    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (!clause || !ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      otherStatements.push({ start, end });
      continue;
    }

    const parsed: ParsedImport = {
      start,
      end,
      text: text.slice(start, end),
      moduleSpecifier: statement.moduleSpecifier.text,
      isTypeOnly: clause.isTypeOnly,
      named: [],
    };

    if (clause.name) {
      parsed.defaultName = clause.name.text;
      parsed.defaultNameOffset = clause.name.getStart(sourceFile) - start;
    }

    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      parsed.namespaceName = bindings.name.text;
    } else if (bindings) {
      for (const element of bindings.elements) {
        parsed.named.push({
          localName: element.name.text,
          propertyName: element.propertyName?.text,
          isTypeOnly: clause.isTypeOnly || element.isTypeOnly,
          nameOffset: element.name.getStart(sourceFile) - start,
        });
      }
    }

    imports.push(parsed);
  }

  return { imports, otherStatements, referencedNames, hasJsx };
}

/**
 * Names an import statement binds locally.
 */
function localNamesOf(imp: ParsedImport): string[] {
  const names: string[] = [];
  if (imp.defaultName) names.push(imp.defaultName);
  if (imp.namespaceName) names.push(imp.namespaceName);
  names.push(...imp.named.map((n) => n.localName));
  return names;
}

/**
 * True when `import React from 'react'` is load-bearing even with no `React`
 * reference in the file — the classic JSX transform compiles `<div/>` to
 * `React.createElement`. Under the automatic runtime (`jsx: react-jsx`) it is
 * genuinely unused and safe to drop.
 */
function isClassicJsxPragma(imp: ParsedImport, hasJsx: boolean, jsxMode: string | undefined): boolean {
  if (!hasJsx || imp.moduleSpecifier !== 'react') return false;
  if (jsxMode === 'react-jsx' || jsxMode === 'react-jsxdev') return false;
  return !!(imp.defaultName || imp.namespaceName);
}

/**
 * Drops import bindings that nothing in the file references, and any statement
 * left with no bindings.
 *
 * Unused imports are computed here rather than asked of the editor. The two
 * editor routes — the `source.removeUnusedImports` code action and `Unnecessary`
 * diagnostics — are both unreliable in this toolchain: the TS 7 native server
 * ships no source code actions at all, and diagnostics arrive asynchronously, so
 * whether an import got cleaned up depended on what the language server happened
 * to have published when the command ran. Applying the editor's edit was also
 * the original source of the flicker. The AST is already parsed, the answer does
 * not depend on another process, and the result is the same on every run.
 *
 * The reference set is conservative: a name mentioned in a shadowing inner scope
 * still counts, so the failure mode is an unused import surviving rather than a
 * used one being deleted.
 */
function removeUnusedBindings(
  imports: ParsedImport[],
  referencedNames: Set<string>,
  hasJsx: boolean,
  jsxMode: string | undefined
): ParsedImport[] {
  const kept: ParsedImport[] = [];

  for (const imp of imports) {
    if (isClassicJsxPragma(imp, hasJsx, jsxMode)) {
      kept.push(imp);
      continue;
    }

    const isUsed = (name: string) => referencedNames.has(name);
    if (localNamesOf(imp).every(isUsed)) {
      kept.push(imp);
      continue;
    }

    const next: ParsedImport = {
      ...imp,
      defaultName: imp.defaultName && isUsed(imp.defaultName) ? imp.defaultName : undefined,
      namespaceName: imp.namespaceName && isUsed(imp.namespaceName) ? imp.namespaceName : undefined,
      named: imp.named.filter((binding) => isUsed(binding.localName)),
    };

    if (next.defaultName || next.namespaceName || next.named.length) kept.push(next);
  }

  return kept;
}

/**
 * Renders an import, wrapping the named bindings the way the project's formatter
 * would so it has nothing to reflow on save. No trailing semicolon — that is
 * added once at the end, to match the file's style.
 */
function renderImport(
  options: {
    typeOnly?: boolean;
    defaultName?: string;
    namespaceName?: string;
    named?: string[];
    moduleSpecifier: string;
  },
  style: OutputStyle
): string {
  const { typeOnly, defaultName, namespaceName, named = [], moduleSpecifier } = options;
  const from = `${style.quote}${moduleSpecifier}${style.quote}`;
  const keyword = typeOnly ? 'import type' : 'import';

  const clauses: string[] = [];
  if (defaultName) clauses.push(defaultName);
  if (namespaceName) clauses.push(`* as ${namespaceName}`);
  if (named.length) clauses.push(`{ ${named.join(', ')} }`);

  if (!clauses.length) return `import ${from}`;

  // Reserve a column for the semicolon appended later, so the wrap decision
  // matches what the formatter measures.
  const reserved = style.semicolons ? 1 : 0;
  const singleLine = `${keyword} ${clauses.join(', ')} from ${from}`;
  if (singleLine.length + reserved <= style.printWidth || named.length < 2) return singleLine;

  const head = [defaultName, namespaceName && `* as ${namespaceName}`].filter(Boolean).join(', ');
  const prefix = head ? `${keyword} ${head}, {` : `${keyword} {`;
  const body = named
    .map((entry, index) => `  ${entry}${index === named.length - 1 && !style.trailingComma ? '' : ','}`)
    .join('\n');

  return `${prefix}\n${body}\n} from ${from}`;
}

/** Renders a named binding back to source form (`A`, `A as B`, `type A`). */
function renderBinding(binding: NamedBinding, includeTypeKeyword: boolean): string {
  const name = binding.propertyName ? `${binding.propertyName} as ${binding.localName}` : binding.localName;
  return includeTypeKeyword && binding.isTypeOnly ? `type ${name}` : name;
}

function renderParsedImport(imp: ParsedImport, moduleSpecifier: string, style: OutputStyle): string {
  return renderImport(
    {
      typeOnly: imp.isTypeOnly,
      defaultName: imp.defaultName,
      namespaceName: imp.namespaceName,
      // `import type { ... }` already carries the keyword on the clause.
      named: imp.named.map((binding) => renderBinding(binding, !imp.isTypeOnly)),
      moduleSpecifier,
    },
    style
  );
}

/**
 * Rewrites `@mui/material` and `@mui/system` barrel imports to per-component
 * `@mui/material/*` targets for better tree shaking.
 */
function transformMuiImport(imp: ParsedImport, moduleSpecifier: string, style: OutputStyle): string[] {
  const isBarrelImport = moduleSpecifier === '@mui/material' || moduleSpecifier === '@mui/system';
  if (!isBarrelImport || !imp.named.length || imp.defaultName || imp.namespaceName) {
    return [renderParsedImport(imp, moduleSpecifier, style)];
  }

  // The path segment comes from the *exported* name, so `{ Box as B }` still
  // resolves to '@mui/material/Box' while keeping the local binding `B`.
  const exportedNameOf = (binding: NamedBinding) => binding.propertyName ?? binding.localName;

  const styleTokens: NamedBinding[] = [];
  const components: NamedBinding[] = [];
  const others: NamedBinding[] = [];

  for (const binding of imp.named) {
    const exported = exportedNameOf(binding);
    if (MUI_STYLE_TOKENS.includes(exported)) styleTokens.push(binding);
    else if (/^[A-Z]/.test(exported) && !exported.endsWith('Props')) components.push(binding);
    else others.push(binding);
  }

  const renderBarrel = (bindings: NamedBinding[], target: string): string[] =>
    bindings.length
      ? [
          renderImport(
            {
              typeOnly: imp.isTypeOnly,
              named: bindings.map((b) => renderBinding(b, !imp.isTypeOnly)),
              moduleSpecifier: target,
            },
            style
          ),
        ]
      : [];

  return [
    ...renderBarrel(styleTokens, '@mui/material/styles'),
    ...components.map((component) =>
      renderImport(
        {
          typeOnly: imp.isTypeOnly || component.isTypeOnly,
          defaultName: component.localName,
          moduleSpecifier: `@mui/material/${exportedNameOf(component)}`,
        },
        style
      )
    ),
    ...renderBarrel(others, '@mui/material'),
  ];
}

function getModulePathFromImport(importLine: string): string {
  const match = importLine.match(/from\s*['"]([^'"]+)['"]/);
  if (match?.[1]) return match[1];

  const directImportMatch = importLine.match(/^import\s*['"]([^'"]+)['"]/);
  if (directImportMatch?.[1]) return directImportMatch[1];

  return '';
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Converts a relative module specifier to a workspace-absolute `src/...` path.
 * Pure path arithmetic — it does not consult the language service.
 */
function toAbsoluteSpecifier(moduleSpecifier: string, document: vscode.TextDocument): string {
  if (!moduleSpecifier.startsWith('.')) return moduleSpecifier;

  try {
    // The folder that owns this file; `workspaceFolders[0]` is the wrong root in
    // a multi-root workspace.
    const folder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) return moduleSpecifier;

    const workspaceRoot = folder.uri.fsPath;
    const absolutePath = path.resolve(path.dirname(document.uri.fsPath), moduleSpecifier);

    if (!isInside(workspaceRoot, absolutePath)) return moduleSpecifier;

    const relativeToSrc = path.relative(path.join(workspaceRoot, 'src'), absolutePath);
    const normalizedPath = relativeToSrc.split(path.sep).join('/');

    if (normalizedPath && !normalizedPath.startsWith('..')) return `src/${normalizedPath}`;
  } catch (error) {
    // Keep the original specifier if conversion fails.
  }

  return moduleSpecifier;
}

/** Which bucket a `src/...` import belongs in. */
function bucketForSrcImport(modulePath: string, isType = false): string {
  if (isType) return 'types';

  for (const group of GROUPS) {
    if (!group.match) continue;
    if (group.match(modulePath)) return group.key;
  }

  return 'other';
}

function sortByLength(names: string[]): string[] {
  return [...names].sort((a, b) => a.length - b.length);
}

/** A rendered import waiting to be filed into a group bucket. */
interface Placement {
  bucket: string;
  line: string;
  /** Type lines are de-duplicated; value lines are not. */
  dedupe?: boolean;
}

/**
 * Splits `src/...` imports into type and value buckets.
 *
 * Classification is parallel (one hover round-trip per symbol), but the results
 * are filed afterwards in source order rather than as each hover returns.
 * Filing from inside the async callbacks made bucket order depend on which
 * round-trip finished first, so imports that sort equal — same group, same
 * width — came out in a different order on every run.
 */
async function processSrcImports(
  srcImports: ImportEntry[],
  document: vscode.TextDocument,
  buckets: Record<string, string[]>,
  style: OutputStyle
): Promise<void> {
  const perImport = await Promise.all(
    srcImports.map(async ({ converted, modulePath, source }): Promise<Placement[]> => {
      // `import type ... from '...'` is already unambiguous — no hover needed.
      if (source.isTypeOnly) {
        return [{ bucket: 'types', line: converted, dedupe: true }];
      }

      if (source.defaultName && !source.namespaceName && !source.named.length) {
        const hoverPosition = document.positionAt(source.start + (source.defaultNameOffset ?? 0));
        const isType = await isTypeSymbol(document, hoverPosition);

        return [{ bucket: bucketForSrcImport(modulePath, isType), line: converted }];
      }

      if (source.named.length && !source.defaultName && !source.namespaceName) {
        const classifications = await Promise.all(
          source.named.map(async (binding) => {
            if (binding.isTypeOnly) return { binding, isType: true };

            const hoverPosition = document.positionAt(source.start + binding.nameOffset);

            return { binding, isType: await isTypeSymbol(document, hoverPosition) };
          })
        );

        const typeNames = sortByLength(
          classifications.filter((c) => c.isType).map((c) => renderBinding(c.binding, false))
        );
        const valueNames = sortByLength(
          classifications.filter((c) => !c.isType).map((c) => renderBinding(c.binding, false))
        );

        const placements: Placement[] = [];
        if (typeNames.length) {
          const line = renderImport({ named: typeNames, moduleSpecifier: modulePath }, style);
          placements.push({ bucket: 'types', line, dedupe: true });
        }
        if (valueNames.length) {
          const line = renderImport({ named: valueNames, moduleSpecifier: modulePath }, style);
          placements.push({ bucket: bucketForSrcImport(modulePath), line });
        }
        return placements;
      }

      // Mixed or namespace clauses keep their shape and are categorized by path.
      return [{ bucket: bucketForSrcImport(modulePath), line: converted }];
    })
  );

  for (const placement of perImport.flat()) {
    const bucket = buckets[placement.bucket];
    if (placement.dedupe && bucket.includes(placement.line)) continue;
    bucket.push(placement.line);
  }
}

async function groupAndSortImports(
  entries: ImportEntry[],
  document: vscode.TextDocument,
  style: OutputStyle
): Promise<string> {
  const groupBuckets: Record<string, string[]> = {};
  GROUPS.forEach((g) => {
    groupBuckets[g.key] = [];
  });

  let remaining = entries;

  for (const group of GROUPS) {
    if (!group.fromPath) continue;

    remaining = remaining.filter((entry) => {
      if (!group.match!(entry.modulePath)) return true;

      if (group.key === 'mui') {
        groupBuckets[group.key].push(...transformMuiImport(entry.source, entry.modulePath, style));
      } else {
        groupBuckets[group.key].push(entry.converted);
      }
      return false;
    });
  }

  // `thirdparty` claims every non-`src/` path, so in practice nothing reaches
  // the `other` bucket here — it stays as the fallback if that ever changes.
  const srcImports: ImportEntry[] = [];
  for (const entry of remaining) {
    if (entry.modulePath.startsWith('src/')) srcImports.push(entry);
    else groupBuckets['other'].push(entry.converted);
  }

  await processSrcImports(srcImports, document, groupBuckets, style);

  return formatGroupsToOutput(groupBuckets, style);
}

function formatGroupsToOutput(groupBuckets: Record<string, string[]>, style: OutputStyle): string {
  const terminate = (line: string) => (style.semicolons ? `${line};` : line);

  const formatGroup = (label: string, lines: string[]): string[] => {
    if (!lines.length) return [];

    // Wrapped imports sort by their widest line, not their total length. Widths
    // are measured once rather than inside the comparator.
    const widthOf = (imp: string) =>
      imp.includes('\n') ? Math.max(...imp.split('\n').map((line) => line.length)) : imp.length;

    const sortedImports = lines
      .map((line) => ({ line, width: widthOf(line) }))
      .sort((a, b) => a.width - b.width)
      .map((measured) => measured.line);

    return [`// ** ${label} Imports`, ...sortedImports.map(terminate)];
  };

  return GROUPS.map((group) => formatGroup(group.label, groupBuckets[group.key]))
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}

/** The range covering the import block, from exact statement offsets. */
function getImportRange(document: vscode.TextDocument, snapshot: string, firstStart: number, lastEnd: number) {
  // Walk back over blank lines and previously generated group headers.
  let firstImportLineNum = document.positionAt(firstStart).line;
  while (firstImportLineNum > 0) {
    const trimmedText = document.lineAt(firstImportLineNum - 1).text.trim();
    if (trimmedText === '' || (trimmedText.startsWith('// ** ') && trimmedText.endsWith(' Imports'))) {
      firstImportLineNum--;
    } else {
      break;
    }
  }

  const rangeStart = document.lineAt(firstImportLineNum).range.start;

  const onlyWhitespaceAfter = /^\s*$/.test(snapshot.slice(lastEnd));
  const rangeEnd = onlyWhitespaceAfter
    ? document.lineAt(document.lineCount - 1).range.end
    : document.positionAt(lastEnd);

  return new vscode.Range(rangeStart, rangeEnd);
}

async function organizeImports() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;

  try {
    // One snapshot for the whole pipeline. Every offset refers to this text and
    // nothing mutates the document, so they stay valid up to the final edit.
    const snapshot = document.getText();
    const startVersion = document.version;

    const { imports, otherStatements, referencedNames, hasJsx } = parseModule(snapshot, document.uri.fsPath);
    if (!imports.length) return;

    const [style, jsxMode] = await Promise.all([resolveStyle(document, imports), readJsxMode(document)]);

    // May be empty — a file whose every import is unused still gets them cleared.
    const usedImports = removeUnusedBindings(imports, referencedNames, hasJsx, jsxMode);

    const entries: ImportEntry[] = usedImports.map((imp) => {
      const converted = renderParsedImport(imp, toAbsoluteSpecifier(imp.moduleSpecifier, document), style);

      // Read back out of the rendered text rather than reusing the specifier:
      // the renderer does not escape quotes, so for a path containing one the
      // two disagree, and every downstream decision is made on this string.
      return { source: imp, converted, modulePath: getModulePathFromImport(converted) };
    });

    const groupedAndSortedImports = await groupAndSortImports(entries, document, style);

    // Built from the original, pre-removal statements so the range still covers
    // whatever was dropped.
    const importRange = getImportRange(document, snapshot, imports[0].start, imports[imports.length - 1].end);

    // Side-effect imports and re-exports inside that range are not rewritten,
    // but must not be swallowed by the replacement either.
    const rangeStartOffset = document.offsetAt(importRange.start);
    const rangeEndOffset = document.offsetAt(importRange.end);
    const preserved = otherStatements
      .filter((s) => s.start >= rangeStartOffset && s.end <= rangeEndOffset)
      .map((s) => snapshot.slice(s.start, s.end));

    let replacement = [preserved.join('\n'), groupedAndSortedImports].filter(Boolean).join('\n\n');

    // The walk-back absorbs the blank line separating the import block from
    // whatever precedes it. Put it back, so repeated runs are idempotent.
    const startLine = importRange.start.line;
    if (replacement && startLine > 0 && document.lineAt(startLine - 1).text.trim() !== '') {
      replacement = `\n${replacement}`;
    }

    if (document.version !== startVersion) {
      vscode.window.showWarningMessage('Import organization skipped: the file changed while it was being analyzed.');
      return;
    }

    // Nothing left to write: swallow the newline too, so clearing the block does
    // not leave an empty line behind.
    const targetRange =
      !replacement && importRange.end.line + 1 < document.lineCount
        ? new vscode.Range(importRange.start, new vscode.Position(importRange.end.line + 1, 0))
        : importRange;

    const applied = await editor.edit((editBuilder) => {
      editBuilder.replace(targetRange, replacement);
    });

    if (!applied) {
      vscode.window.showWarningMessage('Import organization could not be applied to the editor.');
      return;
    }

    await document.save();
  } catch (error) {
    vscode.window.showErrorMessage(
      `Import organization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('importFormatter.organizeImports', organizeImports);
  context.subscriptions.push(disposable);
}

export function deactivate() {
  // Cleanup if needed
}
