import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';

/**
 * Transforms a single MUI import line with named imports into individual default imports,
 * but only if all named imports appear to be components.
 */
function transformMuiImport(importLine: string): string[] {
  const componentRegex = /import {([^}]+)} from ['"]@mui\/(material|icons-material)[''];?/;
  const match = importLine.match(componentRegex);
  if (!match) return [importLine];

  const namedImports = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
  const modulePath = match[2];

  const allAreComponents = namedImports.every((imp) => /^[A-Z]/.test(imp) && !imp.endsWith('Props'));
  if (allAreComponents) {
    return namedImports.map((imp) => `import ${imp} from '@mui/${modulePath}/${imp}';`);
  } else {
    return [importLine];
  }
}

/**
 * Async helper to determine the TypeScript ScriptElementKind for a symbol at a given position.
 * This is the core of our semantic type detection.
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

    if (hovers && hovers.length > 0) {
      const hoverContent = hovers[0].contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');

      let inferredKind: ts.ScriptElementKind | undefined;

      if (
        /\b(interface|type|enum|class|namespace)\b\s+\w+/.test(hoverContent) ||
        /\(alias\)\s*type\s+\w+/.test(hoverContent)
      ) {
        if (/\binterface\b/.test(hoverContent)) inferredKind = ts.ScriptElementKind.interfaceElement;
        else if (/\btype\b|\(alias\)\s*type\s+\w+/.test(hoverContent)) inferredKind = ts.ScriptElementKind.typeElement;
        else if (/\benum\b/.test(hoverContent)) inferredKind = ts.ScriptElementKind.enumElement;
        else if (/\bclass\b/.test(hoverContent)) inferredKind = ts.ScriptElementKind.classElement;
        else if (/\bnamespace\b/.test(hoverContent)) inferredKind = ts.ScriptElementKind.moduleElement;
      } else if (
        /\b(const|let|var)\b\s+\w+\s*:\s*\S+/.test(hoverContent) ||
        /\bfunction\b\s+\w+\s*\(/.test(hoverContent)
      ) {
        if (/\bfunction\b/.test(hoverContent)) inferredKind = ts.ScriptElementKind.functionElement;
        else inferredKind = ts.ScriptElementKind.variableElement;
      } else if (/\b(React\.FC|React\.ComponentType|JSX\.Element|elementType)\b/.test(hoverContent)) {
        inferredKind = ts.ScriptElementKind.functionElement;
      }

      return inferredKind;
    }
  } catch (e) {
    // Suppress errors during TSLS query, but good for debugging if needed
  }
  return undefined;
}

/**
 * Determines if a symbol's ScriptElementKind indicates it is a type.
 */
function isSymbolATypeKind(kind: ts.ScriptElementKind | undefined): boolean {
  if (kind === undefined) return false;

  const isType =
    kind === ts.ScriptElementKind.interfaceElement ||
    kind === ts.ScriptElementKind.typeElement ||
    kind === ts.ScriptElementKind.enumElement ||
    kind === ts.ScriptElementKind.classElement ||
    kind === ts.ScriptElementKind.moduleElement ||
    kind === ts.ScriptElementKind.enumMemberElement ||
    kind === ts.ScriptElementKind.typeParameterElement;
  return isType;
}

/**
 * Sorts named imports within a multi-line import statement by their string length.
 * Adds consistent indentation and a trailing comma.
 * @param importLine The full import statement string.
 * @returns The import statement with named imports sorted, or the original line if not multi-line.
 */
function sortNamedImportsInMultiLine(importLine: string): string {
  const multiLineImportRegex = /(import\s*{)([\s\S]+?)(}\s*from\s*['"].*[''];?)/;
  const match = importLine.match(multiLineImportRegex);

  if (!match) return importLine;

  const prefix = match[1];
  const rawNamedImportsContent = match[2];
  const suffix = match[3];

  if (!rawNamedImportsContent.includes('\n')) return importLine;

  const namedImports = rawNamedImportsContent
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  namedImports.sort((a, b) => a.length - b.length);

  const indentation = '  ';
  const sortedNamedImportsFormatted = namedImports.map((imp) => `${indentation}${imp},`).join('\n');

  return `${prefix}\n${sortedNamedImportsFormatted}\n${suffix}`;
}

/**
 * Extracts the module path from an import line.
 * e.g., "import { foo } from 'bar/baz';" -> "bar/baz"
 * "import 'qux';" -> "qux"
 */
function getModulePathFromImport(importLine: string): string {
  const match = importLine.match(/from\s*['"]([^'"]+)['"];?/);
  if (match && match[1]) {
    return match[1];
  }
  const directImportMatch = importLine.match(/^import\s*['"]([^'"]+)['"];?/);
  if (directImportMatch && directImportMatch[1]) {
    return directImportMatch[1];
  }
  return importLine;
}

/**
 * Converts a relative import path to an absolute 'src/' path.
 *
 * @param importLine The original import line.
 * @param document The VS Code TextDocument.
 * @returns The transformed import line with an absolute 'src/' path, or the original if not a relative 'src' import.
 */
async function convertRelativeImportsToAbsolute(importLine: string, document: vscode.TextDocument): Promise<string> {
  // Regex to capture the full leading part (import ... from), the module path, and the trailing part
  const modulePathMatch = importLine.match(/^(import\s*(?:[\w*{}\n\r\t, ]+)?\s*from\s*['"])([^'"]+)(['"];?)$/);

  if (!modulePathMatch) {
    return importLine;
  }

  const leadingPart = modulePathMatch[1];
  const originalModulePath = modulePathMatch[2];
  const trailingPart = modulePathMatch[3];

  // Check if it's a relative path (starts with ./ or ../)
  if (!originalModulePath.startsWith('./') && !originalModulePath.startsWith('../')) {
    return importLine;
  }

  const currentFilePath = document.uri.fsPath;
  const currentFileDir = path.dirname(currentFilePath);

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return importLine; // No workspace folder open, cannot convert relative imports reliably
  }

  const workspaceRoot = workspaceFolders.map((f) => f.uri.fsPath).find((root) => currentFilePath.startsWith(root));
  if (!workspaceRoot) {
    return importLine; // Current file not within an open workspace folder
  }

  let resolvedFullPath = path.resolve(currentFileDir, originalModulePath);

  if (!resolvedFullPath.startsWith(workspaceRoot)) {
    return importLine; // Resolved path is outside workspace root
  }

  let newModulePath = path.relative(workspaceRoot, resolvedFullPath);
  newModulePath = newModulePath.replace(/\\/g, '/'); // Convert Windows backslashes to forward slashes

  // Remove common file extensions
  const ext = path.extname(newModulePath);
  const commonExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];
  if (commonExtensions.includes(ext)) {
    newModulePath = newModulePath.slice(0, -ext.length);
  }

  // If the path ends with '/index', remove it (e.g., 'src/utils/index' -> 'src/utils')
  if (newModulePath.endsWith('/index')) {
    newModulePath = newModulePath.slice(0, -'/index'.length);
  }

  // Ensure the new path starts with 'src/' and adjust if 'src' is found deeper in the path.
  if (!newModulePath.startsWith('src/')) {
    const parts = newModulePath.split('/');
    const srcIndex = parts.indexOf('src');
    if (srcIndex !== -1) {
      newModulePath = parts.slice(srcIndex).join('/');
    } else {
      return importLine; // Could not find 'src' segment for a path that should be under src
    }
  }

  return `${leadingPart}${newModulePath}${trailingPart}`;
}

export async function groupAndSortImports(imports: string[], document: vscode.TextDocument): Promise<string> {
  const groups: Record<string, string[]> = {
    next: [],
    react: [],
    mui: [],
    thirdparty: [],
    types: [],
    reduxstore: [],
    api: [],
    hooks: [],
    utils: [],
    local: [],
    unknown: [],
  };

  const importQueue: string[] = [...imports];
  const documentText = document.getText();

  while (importQueue.length > 0) {
    let imp = importQueue.shift()!;

    // Always sort named imports within multi-line statements first
    imp = sortNamedImportsInMultiLine(imp);

    const namedImportsMatch = imp.match(/import {([^}]+)} from ['"]([^'"]+)[''];?/);
    const modulePath = namedImportsMatch ? namedImportsMatch[2] : '';

    // Determine if it's a 'src' import (based on the path *after* potential conversion)
    const isFromSrc = modulePath.startsWith('src/');

    // --- Handle TSLS analysis and splitting for SRC named imports first ---
    if (namedImportsMatch && isFromSrc) {
      const namedImports = namedImportsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s);

      let typesToImport: string[] = [];
      let nonTypesToImport: string[] = [];

      const impLineStartPos = document.positionAt(documentText.indexOf(imp));

      if (namedImports.length > 0 && impLineStartPos.line !== -1) {
        const importLineNumber = impLineStartPos.line;
        const currentLineText = document.lineAt(importLineNumber).text;

        const symbolClassifications = await Promise.all(
          namedImports.map(async (name) => {
            const startCharInLine = currentLineText.indexOf(name);
            if (startCharInLine === -1) {
              return { name, isType: false }; // Cannot find symbol in line for TSLS check
            }
            const position = new vscode.Position(importLineNumber, startCharInLine);
            const kind = await getSymbolScriptElementKind(document, position, name);
            return { name, isType: isSymbolATypeKind(kind) };
          })
        );

        typesToImport = symbolClassifications.filter((s) => s.isType).map((s) => s.name);
        nonTypesToImport = symbolClassifications.filter((s) => !s.isType).map((s) => s.name);

        if (typesToImport.length > 0 && nonTypesToImport.length > 0) {
          groups.types.push(`import { ${typesToImport.join(', ')} } from '${modulePath}';`);
          imp = `import { ${nonTypesToImport.join(', ')} } from '${modulePath}';`;
        } else if (typesToImport.length > 0 && nonTypesToImport.length === 0) {
          groups.types.push(imp);
          continue;
        }
      }
    }
    // If it's a .d.ts import and not handled by TSLS splitting
    const isDtsFile = /\.d\.ts['"]/.test(imp);
    if (isDtsFile) {
      groups.types.push(imp);
      continue;
    }

    // --- General Grouping Logic ---
    if (getModulePathFromImport(imp).startsWith('next/')) {
      groups.next.push(imp);
    } else if (/from ['"]react-(redux|hook-form)|react-hot-toast|redux/.test(imp)) {
      groups.thirdparty.push(imp);
    } else if (getModulePathFromImport(imp).startsWith('react')) {
      groups.react.push(imp);
    } else if (getModulePathFromImport(imp).startsWith('@mui/')) {
      const transformedImports = transformMuiImport(imp);
      groups.mui.push(...transformedImports);
    } else if (getModulePathFromImport(imp).startsWith('src/store/')) {
      groups.reduxstore.push(imp);
    } else if (getModulePathFromImport(imp).startsWith('src/api-clients/')) {
      groups.api.push(imp);
    } else if (getModulePathFromImport(imp).includes('/hooks')) {
      groups.hooks.push(imp);
    } else if (getModulePathFromImport(imp).includes('/utils')) {
      groups.utils.push(imp);
    } else if (isFromSrc) {
      groups.local.push(imp);
    } else {
      groups.unknown.push(imp);
    }
  }

  const formatGroup = (label: string, lines: string[]): string[] => {
    if (!lines.length) return [];

    const sorted = lines.sort((a: string, b: string) => {
      const isMultiLineA = a.includes('\n');
      const isMultiLineB = b.includes('\n');

      // 1. Primary Sort: Multi-line imports before single-line imports
      if (isMultiLineA && !isMultiLineB) return -1;
      if (!isMultiLineA && isMultiLineB) return 1;

      // 2. Secondary Sort: By overall line length (shortest first)
      const lengthComparison = a.length - b.length;
      if (lengthComparison !== 0) {
        return lengthComparison;
      }
      return 0; // Fallback for identical lines
    });

    return [`// ** ${label} Imports`, ...sorted];
  };

  const finalOutput: string[] = [];
  let firstGroup = true;

  // Define the desired order of groups
  const groupOrder = [
    'Next',
    'React',
    'MUI',
    'Third Party',
    'Types',
    'Redux Store',
    'API',
    'Hooks',
    'Local',
    'Utils',
    'Unknown',
  ];

  for (const label of groupOrder) {
    // Map label (e.g., 'Redux Store') to actual group key (e.g., 'reduxstore')
    const groupKey = label.toLowerCase().replace(/\s/g, '');
    const groupLines = formatGroup(label, groups[groupKey]);

    if (groupLines.length > 0) {
      if (!firstGroup) {
        finalOutput.push(''); // Add a single empty line *before* the current group
      }
      finalOutput.push(...groupLines);
      firstGroup = false;
    }
  }

  return finalOutput.join('\n');
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand('importGrouper.organizeImports', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const text = document.getText();

    // Regex to capture full import statements
    const importRegex = /^import(?:["'\s]*(?:[\w*{}\n\r\t, ]+)from\s*)?["'`].*["'`];?\s*$/gm;

    const importMatches = [...text.matchAll(importRegex)];
    let originalImports = importMatches.map((m) => m[0].trim());

    if (!originalImports.length) return;

    // Step 1: Convert relative imports to absolute 'src/' paths
    const convertedImportsPromises = originalImports.map((imp) => convertRelativeImportsToAbsolute(imp, document));
    const importsAfterPathConversion = await Promise.all(convertedImportsPromises);

    // Step 2: Perform grouping and sorting on the converted imports
    // This also handles `multi-line import sorting` and `type splitting`
    const groupedAndSortedImports = await groupAndSortImports(importsAfterPathConversion, document);

    // Calculate range for replacement based on original imports
    const firstImportMatchIndex = text.indexOf(originalImports[0]);
    const lastImportMatchIndex = text.lastIndexOf(originalImports[originalImports.length - 1]);

    // Get the line number of the first import statement
    const firstImportLineNum = document.positionAt(firstImportMatchIndex).line;
    const lastImportLineNum = document.positionAt(lastImportMatchIndex).line;

    // Find the true start of the import block by looking upwards from the first import line.
    // This will include any preceding group comments or blank lines.
    let replacementStartLine = firstImportLineNum;
    while (replacementStartLine > 0) {
      const currentLine = document.lineAt(replacementStartLine - 1);
      const trimmedText = currentLine.text.trim();

      // Extend the range upwards if the line above is empty or looks like a group comment
      if (trimmedText === '' || (trimmedText.startsWith('// ** ') && trimmedText.endsWith(' Imports'))) {
        replacementStartLine--;
      } else {
        // Found a non-empty, non-group-comment line, stop extending upwards
        break;
      }
    }

    // Define the full range to be replaced
    const fullRange = new vscode.Range(
      document.lineAt(replacementStartLine).range.start, // Start of the *adjusted* line
      document.lineAt(lastImportLineNum).range.end // End of the line of the last import
    );

    editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, groupedAndSortedImports);
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
