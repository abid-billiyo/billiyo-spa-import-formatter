import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';

// Define import group categories and their matching rules
const GROUPS = [
  { key: 'next', label: 'Next', match: (p: string) => p.startsWith('next/') },
  { key: 'react', label: 'React', match: (p: string) => p === 'react' },
  { key: 'mui', label: 'MUI', match: (p: string) => p.startsWith('@mui/') },
  {
    key: 'thirdparty',
    label: 'Third Party',
    match: (p: string) => !p.startsWith('src/') && p !== 'react' && !p.startsWith('next/') && !p.startsWith('@mui/'),
  },
  { key: 'types', label: 'Types', match: (_p: string, line: string) => line.startsWith('import') },
  { key: 'reduxstore', label: 'Redux Store', match: (p: string) => p.startsWith('src/store/') },
  { key: 'api', label: 'API', match: (p: string) => p.startsWith('src/api-clients/') },
  { key: 'hooks', label: 'Hooks', match: (p: string) => p.includes('/hooks') },
  { key: 'config', label: 'Config', match: (p: string) => p.startsWith('src/configs') },
  {
    key: 'local',
    label: 'Local',
    match: (p: string) =>
      p.startsWith('src/') &&
      !p.startsWith('src/store/') &&
      !p.startsWith('src/api-clients/') &&
      !p.startsWith('src/configs') &&
      !p.includes('/hooks') &&
      !p.includes('/utils'),
  },
  { key: 'utils', label: 'Utils', match: (p: string) => p.includes('/utils') },
  { key: 'other', label: 'Other', match: () => true },
];

// MUI style tokens that should be imported from @mui/material/styles
const MUI_STYLE_TOKENS = ['Direction', 'Theme', 'SxProps', 'useTheme', 'styled'];

// Type definitions
interface ImportPair {
  original: string;
  converted: string;
}

interface SourceImport extends ImportPair {
  position: number;
}

interface SymbolClassification {
  name: string;
  isType: boolean;
}

/**
 * Determines the TypeScript element kind of a symbol at a specific position
 */
async function getSymbolScriptElementKind(
  document: vscode.TextDocument,
  position: vscode.Position,
  symbolName: string
): Promise<ts.ScriptElementKind | undefined> {
  try {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      position
    );

    if (hovers?.length) {
      const hoverContent = hovers[0].contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');

      // Type detection - strict rules for actual TypeScript types
      if (/\binterface\b\s+\w+|\(interface\)/i.test(hoverContent)) return ts.ScriptElementKind.interfaceElement;

      if (/\btype\b\s+\w+\s*=|\(type alias\)|\(type\)/i.test(hoverContent)) return ts.ScriptElementKind.typeElement;

      if (/\benum\b\s+\w+|\(enum\)/i.test(hoverContent)) return ts.ScriptElementKind.enumElement;

      // Value detection - everything else is a value
      // Classes explicitly treated as values
      if (/\bclass\b|\(class\)|class\s+\w+/i.test(hoverContent)) return ts.ScriptElementKind.functionElement;

      if (/\bfunction\b|\(function\)|function\s+\w+/i.test(hoverContent)) return ts.ScriptElementKind.functionElement;

      if (/\b(const|let|var)\b|\(variable\)|const\s+\w+|var\s+\w+|let\s+\w+/i.test(hoverContent))
        return ts.ScriptElementKind.variableElement;

      if (/\b(React\.FC|React\.ComponentType|JSX\.Element|elementType)\b/i.test(hoverContent))
        return ts.ScriptElementKind.functionElement;

      // Implementation details suggesting value
      if (/new\s+\w+|\w+\(|=>|function\s*\(|export\s+(const|let|var|function|default|class)\s+/i.test(hoverContent)) {
        return ts.ScriptElementKind.variableElement;
      }
    }

    // Fallback: PascalCase naming convention typically indicates a class (value)
    if (/^[A-Z][a-zA-Z0-9]*$/.test(symbolName)) {
      return ts.ScriptElementKind.functionElement;
    }
  } catch (error) {
    // Silent error - no need to disrupt user experience
  }

  return undefined;
}

/**
 * Determines if a symbol kind represents a type
 */
function isSymbolATypeKind(kind: ts.ScriptElementKind | undefined): boolean {
  if (!kind) return false;

  return [
    ts.ScriptElementKind.interfaceElement,
    ts.ScriptElementKind.typeElement,
    ts.ScriptElementKind.enumElement,
    ts.ScriptElementKind.typeParameterElement,
  ].includes(kind);
}

/**
 * Transforms MUI imports into optimized format for better tree shaking
 */
function transformMuiImport(importLine: string): string[] {
  const styleImportRegex = /import {([^}]+)} from ['"]@mui\/material['"]/;
  const styleMatch = importLine.match(styleImportRegex);

  if (!styleMatch) return [importLine.replace(/;\s*$/, '')];

  const namedImports = styleMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Group imports by type
  const styleTokens = namedImports.filter((imp) => MUI_STYLE_TOKENS.includes(imp));
  const components = namedImports.filter(
    (imp) => !MUI_STYLE_TOKENS.includes(imp) && /^[A-Z]/.test(imp) && !imp.endsWith('Props')
  );
  const others = namedImports.filter((imp) => !styleTokens.includes(imp) && !components.includes(imp));

  const result: string[] = [];

  // Add style imports
  if (styleTokens.length > 0) {
    result.push(`import { ${styleTokens.join(', ')} } from '@mui/material/styles'`);
  }

  // Add component imports
  for (const comp of components) {
    result.push(`import ${comp} from '@mui/material/${comp}'`);
  }

  // Add other imports
  if (others.length > 0) {
    result.push(`import { ${others.join(', ')} } from '@mui/material'`);
  }

  return result;
}

/**
 * Extracts the module path from an import statement
 */
function getModulePathFromImport(importLine: string): string {
  // Check for 'from' import style
  const match = importLine.match(/from\s*['"]([^'"]+)['"]/);
  if (match?.[1]) return match[1];

  // Check for direct import style
  const directImportMatch = importLine.match(/^import\s*['"]([^'"]+)['"]/);
  if (directImportMatch?.[1]) return directImportMatch[1];

  return '';
}

/**
 * Formats an import statement with proper spacing and line breaks
 */
function formatImportStatement(imports: string[], modulePath: string, typeOnly = false): string {
  const sortedImports = [...imports].sort((a, b) => a.length - b.length);
  const importList = sortedImports.join(', ');
  const importType = 'import';
  const singleLine = `${importType} { ${importList} } from '${modulePath}'`;

  // Single import or short import list - use single line
  if (imports.length === 1) {
    return singleLine;
  }

  // Long import list - format with line breaks for readability
  if (singleLine.length > 120) {
    const formattedImports = sortedImports.map((imp) => `  ${imp},`).join('\n');
    return `${importType} {\n${formattedImports}\n} from '${modulePath}'`;
  }

  return singleLine;
}

/**
 * Converts relative import paths to absolute paths based on workspace structure
 */
async function convertRelativeImportsToAbsolute(importLine: string, document: vscode.TextDocument): Promise<string> {
  const match = importLine.match(/from\s*['"]([^'"]+)['"]/);
  if (!match) return importLine.replace(/;\s*$/, '');

  let modulePath = match[1];
  // Don't process absolute imports
  if (!modulePath.startsWith('.')) return importLine.replace(/;\s*$/, '');

  try {
    const fileDir = path.dirname(document.uri.fsPath);
    const absolutePath = path.resolve(fileDir, modulePath);
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) return importLine.replace(/;\s*$/, '');

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // Only convert paths within the workspace
    if (absolutePath.startsWith(workspaceRoot)) {
      const srcPath = path.join(workspaceRoot, 'src');
      const relativeToSrc = path.relative(srcPath, absolutePath);
      const normalizedPath = relativeToSrc.replace(/\\/g, '/');

      if (normalizedPath && !normalizedPath.startsWith('..')) {
        modulePath = `src/${normalizedPath}`;
      }
    }
  } catch (error) {
    // Silent error - return original import if conversion fails
  }

  return importLine.replace(match[1], modulePath).replace(/;\s*$/, '');
}

/**
 * Categorizes a src import into the appropriate bucket
 */
function categorizeSrcImport(
  importLine: string,
  modulePath: string,
  buckets: Record<string, string[]>,
  kind?: ts.ScriptElementKind
) {
  // Check if it's a type import first
  if (isSymbolATypeKind(kind)) {
    buckets['types'].push(importLine);
    return;
  }

  // Check other categorization rules
  for (const group of GROUPS) {
    if (['types', 'other'].includes(group.key)) continue;
    if (group.match(modulePath, importLine)) {
      buckets[group.key].push(importLine);
      return;
    }
  }

  // Default to other category
  buckets['other'].push(importLine);
}

/**
 * Processes source imports to separate types from values
 */
async function processSrcImports(
  srcImports: SourceImport[],
  document: vscode.TextDocument,
  buckets: Record<string, string[]>
): Promise<void> {
  await Promise.all(
    srcImports.map(async ({ original, converted, position }) => {
      const modulePath = getModulePathFromImport(converted);

      // Handle default imports
      const defaultImportMatch = converted.match(/import (\w+) from ['"]([^'"]+)['"]/);
      if (defaultImportMatch) {
        const identifier = defaultImportMatch[1];
        const identifierIndex = original.indexOf(identifier);
        const hoverPosition = document.positionAt(position + identifierIndex);
        const kind = await getSymbolScriptElementKind(document, hoverPosition, identifier);

        if (isSymbolATypeKind(kind)) {
          buckets['types'].push(`import ${identifier} from '${modulePath}'`);
        } else {
          categorizeSrcImport(converted, modulePath, buckets, kind);
        }
        return;
      }

      // Handle named imports
      const namedImportsMatch = converted.match(/import {([^}]+)} from ['"]([^'"]+)['"]/);
      if (namedImportsMatch) {
        const namedImports = namedImportsMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        // Analyze each named import to determine if it's a type
        const symbolClassifications = await Promise.all(
          namedImports.map(async (name) => {
            const relativeIndex = original.indexOf(name);
            if (relativeIndex === -1) return { name, isType: false };

            const absoluteIndex = position + relativeIndex;
            const hoverPosition = document.positionAt(absoluteIndex);
            const kind = await getSymbolScriptElementKind(document, hoverPosition, name);

            return { name, isType: isSymbolATypeKind(kind) };
          })
        );

        const typesToImport = symbolClassifications.filter((s) => s.isType).map((s) => s.name);
        const nonTypesToImport = symbolClassifications.filter((s) => !s.isType).map((s) => s.name);

        // Handle only types
        if (typesToImport.length > 0 && nonTypesToImport.length === 0) {
          const typesImportLine = formatImportStatement(typesToImport, modulePath, true);
          if (!buckets['types'].includes(typesImportLine)) {
            buckets['types'].push(typesImportLine);
          }
          return;
        }

        // Handle mixed types and non-types
        if (typesToImport.length > 0 && nonTypesToImport.length > 0) {
          const typesImportLine = formatImportStatement(typesToImport, modulePath, true);
          if (!buckets['types'].includes(typesImportLine)) {
            buckets['types'].push(typesImportLine);
          }
          const nonTypesImportLine = formatImportStatement(nonTypesToImport, modulePath);
          categorizeSrcImport(nonTypesImportLine, modulePath, buckets);
          return;
        }

        // Handle only values
        if (nonTypesToImport.length > 0) {
          const nonTypesImportLine = formatImportStatement(nonTypesToImport, modulePath);
          categorizeSrcImport(nonTypesImportLine, modulePath, buckets);
        }
        return;
      }

      // Default categorization
      categorizeSrcImport(converted, modulePath, buckets);
    })
  );
}

/**
 * Groups and sorts imports into predefined categories
 */
async function groupAndSortImports(importPairs: ImportPair[], document: vscode.TextDocument): Promise<string> {
  // Initialize buckets for each group
  const groupBuckets: Record<string, string[]> = {};
  GROUPS.forEach((g) => {
    groupBuckets[g.key] = [];
  });

  let remainingImports = [...importPairs];

  // Process top-level imports first (next, react, mui, thirdparty)
  for (const group of GROUPS) {
    if (['types', 'reduxstore', 'api', 'hooks', 'config', 'local', 'utils', 'other'].includes(group.key)) continue;

    remainingImports = remainingImports.filter((pair) => {
      const modulePath = getModulePathFromImport(pair.converted);

      if (group.match(modulePath, pair.converted)) {
        if (group.key === 'mui') {
          const transformed = transformMuiImport(pair.converted);
          groupBuckets[group.key].push(...transformed);
        } else {
          groupBuckets[group.key].push(pair.converted);
        }
        return false;
      }
      return true;
    });
  }

  // Process config imports
  remainingImports = remainingImports.filter((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (GROUPS.find((g) => g.key === 'config')!.match(modulePath, pair.converted)) {
      groupBuckets['config'].push(pair.converted);
      return false;
    }
    return true;
  });

  // Separate src imports for type analysis
  const srcImports: SourceImport[] = [];
  remainingImports.forEach((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (modulePath.startsWith('src/')) {
      const startIdx = document.getText().indexOf(pair.original);
      srcImports.push({ original: pair.original, converted: pair.converted, position: startIdx });
    }
  });

  // Filter out src imports from remaining imports
  remainingImports = remainingImports.filter((pair) => !getModulePathFromImport(pair.converted).startsWith('src/'));

  // Process src imports with type detection
  await processSrcImports(srcImports, document, groupBuckets);

  // Add any remaining imports to 'other' category
  remainingImports.forEach((pair) => {
    groupBuckets['other'].push(pair.converted);
  });

  // Format each group with headers and sort imports
  return formatGroupsToOutput(groupBuckets);
}

/**
 * Formats grouped imports into final output string
 */
function formatGroupsToOutput(groupBuckets: Record<string, string[]>): string {
  const formatGroup = (label: string, lines: string[]): string[] => {
    if (!lines.length) return [];

    const sortedImports = lines.sort((a, b) => {
      const getEffectiveLength = (imp: string) => {
        if (!imp.includes('\n')) return imp.length;
        return Math.max(...imp.split('\n').map((line) => line.length));
      };
      return getEffectiveLength(a) - getEffectiveLength(b);
    });

    return [`// ** ${label} Imports`, ...sortedImports];
  };

  const finalOutput: string[] = [];
  let firstGroup = true;

  for (const group of GROUPS) {
    const groupLines = formatGroup(group.label, groupBuckets[group.key]);

    if (groupLines.length > 0) {
      if (!firstGroup) finalOutput.push('');
      finalOutput.push(...groupLines);
      firstGroup = false;
    }
  }

  return finalOutput.join('\n');
}

/**
 * Determines the range in the document containing all imports
 */
function getImportRange(document: vscode.TextDocument, imports: string[]): vscode.Range | null {
  if (!imports.length) return null;

  const text = document.getText();
  const firstImportString = imports[0];
  const lastImportString = imports[imports.length - 1];

  const firstImportMatchIndex = text.indexOf(firstImportString);
  if (firstImportMatchIndex === -1) return null;

  const lastImportMatchIndex = text.lastIndexOf(lastImportString);
  if (lastImportMatchIndex === -1) return null;

  const lastImportLength = lastImportString.length;
  const lastImportEndIndex = lastImportMatchIndex + lastImportLength;

  // Find the first line of imports, including preceding comments and blank lines
  let firstImportLineNum = document.positionAt(firstImportMatchIndex).line;
  while (firstImportLineNum > 0) {
    const currentLine = document.lineAt(firstImportLineNum - 1);
    const trimmedText = currentLine.text.trim();
    if (trimmedText === '' || (trimmedText.startsWith('// ** ') && trimmedText.endsWith(' Imports'))) {
      firstImportLineNum--;
    } else {
      break;
    }
  }

  const rangeStart = document.lineAt(firstImportLineNum).range.start;

  // Determine the end of the range
  const trailingText = text.slice(lastImportEndIndex);
  const onlyWhitespaceAfter = /^\s*$/.test(trailingText);

  let rangeEnd: vscode.Position;
  if (onlyWhitespaceAfter) {
    // If only whitespace follows, extend to end of document
    rangeEnd = document.lineAt(document.lineCount - 1).range.end;
  } else {
    // Otherwise, end precisely at the end of last import
    rangeEnd = document.positionAt(lastImportEndIndex);
  }

  return new vscode.Range(rangeStart, rangeEnd);
}

/**
 * Command handler to organize imports in the active document
 */
async function organizeImports() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;

  try {
    // Find all imports in the document
    const text = document.getText();
    const importRegex = /^import[\s\S]*?from\s*['"][^'"]+['"];?/gm;
    const importMatches = [...text.matchAll(importRegex)];
    const originalImports = importMatches.map((m) => m[0].trim());

    if (!originalImports.length) return;

    // Convert relative imports to absolute paths
    const importPairs = await Promise.all(
      originalImports.map(async (imp) => {
        const converted = await convertRelativeImportsToAbsolute(imp, document);
        return { original: imp, converted };
      })
    );

    // Group and sort imports
    const groupedAndSortedImports = await groupAndSortImports(importPairs, document);

    // Find the range containing all imports
    const importRange = getImportRange(document, originalImports);
    if (!importRange) return;

    // Replace imports in document
    await editor.edit((editBuilder) => {
      editBuilder.replace(importRange, groupedAndSortedImports);
    });

    // Save document
    await document.save();
  } catch (error) {
    vscode.window.showErrorMessage(
      `Import organization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('importFormatter.organizeImports', organizeImports);
  context.subscriptions.push(disposable);
}

/**
 * Extension deactivation
 */
export function deactivate() {
  // Cleanup if needed
}
