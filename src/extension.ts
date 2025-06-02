import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';

const GROUPS = [
  { key: 'next', label: 'Next', match: (p: string) => p.startsWith('next/') },
  { key: 'react', label: 'React', match: (p: string) => p === 'react' },
  { key: 'mui', label: 'MUI', match: (p: string) => p.startsWith('@mui/') },
  {
    key: 'thirdparty',
    label: 'Third Party',
    match: (p: string) => !p.startsWith('src/') && p !== 'react' && !p.startsWith('next/') && !p.startsWith('@mui/'),
  },
  { key: 'types', label: 'Types', match: (_p: string, line: string) => line.startsWith('import') }, // changed from 'import type'
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

const MUI_STYLE_TOKENS = ['Direction', 'Theme', 'SxProps', 'useTheme', 'styled'];

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
      if (/\binterface\b|\(interface\)|interface\s+\w+/i.test(hoverContent))
        return ts.ScriptElementKind.interfaceElement;
      if (/\btype\b|\(alias\)\s*type\s+\w+|\(type\)|type\s+\w+/i.test(hoverContent))
        return ts.ScriptElementKind.typeElement;
      if (/\benum\b|\(enum\)|enum\s+\w+/i.test(hoverContent)) return ts.ScriptElementKind.enumElement;
      if (/\bclass\b|\(class\)|class\s+\w+/i.test(hoverContent)) return ts.ScriptElementKind.classElement;
      if (/\bnamespace\b|\(namespace\)|namespace\s+\w+/i.test(hoverContent)) return ts.ScriptElementKind.moduleElement;
      if (/\bfunction\b|\(function\)|function\s+\w+/i.test(hoverContent)) return ts.ScriptElementKind.functionElement;
      if (/\b(const|let|var)\b|\(variable\)|const\s+\w+/i.test(hoverContent))
        return ts.ScriptElementKind.variableElement;
      if (/\b(React\.FC|React\.ComponentType|JSX\.Element|elementType)\b/i.test(hoverContent))
        return ts.ScriptElementKind.functionElement;
    }
  } catch (e) {
    // Silent error
  }
  return undefined;
}

function isSymbolATypeKind(kind: ts.ScriptElementKind | undefined): boolean {
  if (!kind) return false;
  return [
    ts.ScriptElementKind.interfaceElement,
    ts.ScriptElementKind.typeElement,
    ts.ScriptElementKind.enumElement,
    ts.ScriptElementKind.classElement,
    ts.ScriptElementKind.moduleElement,
    ts.ScriptElementKind.enumMemberElement,
    ts.ScriptElementKind.typeParameterElement,
  ].includes(kind);
}

function transformMuiImport(importLine: string): string[] {
  const styleImportRegex = /import {([^}]+)} from ['"]@mui\/material['"]/;
  const styleMatch = importLine.match(styleImportRegex);
  if (styleMatch) {
    const namedImports = styleMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const styleTokens = namedImports.filter((imp) => MUI_STYLE_TOKENS.includes(imp));
    const components = namedImports.filter(
      (imp) => !MUI_STYLE_TOKENS.includes(imp) && /^[A-Z]/.test(imp) && !imp.endsWith('Props')
    );
    const result: string[] = [];
    if (styleTokens.length > 0) {
      result.push(`import { ${styleTokens.join(', ')} } from '@mui/material/styles'`);
    }
    for (const comp of components) {
      result.push(`import ${comp} from '@mui/material/${comp}'`);
    }
    const others = namedImports.filter((imp) => !styleTokens.includes(imp) && !components.includes(imp));
    if (others.length > 0) {
      result.push(`import { ${others.join(', ')} } from '@mui/material'`);
    }
    return result;
  }
  return [importLine.replace(/;\s*$/, '')];
}

function getModulePathFromImport(importLine: string): string {
  const match = importLine.match(/from\s*['"]([^'"]+)['"]/);
  if (match && match[1]) return match[1];
  const directImportMatch = importLine.match(/^import\s*['"]([^'"]+)['"]/);
  if (directImportMatch && directImportMatch[1]) return directImportMatch[1];
  return '';
}

function formatImportStatement(imports: string[], modulePath: string, typeOnly = false): string {
  const sortedImports = [...imports].sort((a, b) => a.length - b.length);
  const importList = sortedImports.join(', ');
  // REMOVE "type" for typeOnly import
  const importType = 'import';
  const singleLine = `${importType} { ${importList} } from '${modulePath}'`;

  if (imports.length === 1) {
    return singleLine;
  }

  if (singleLine.length > 120) {
    const formattedImports = sortedImports.map((imp) => `  ${imp},`).join('\n');
    return `${importType} {\n${formattedImports}\n} from '${modulePath}'`;
  }

  return `${importType} { ${importList} } from '${modulePath}'`;
}

async function convertRelativeImportsToAbsolute(importLine: string, document: vscode.TextDocument): Promise<string> {
  const match = importLine.match(/from\s*['"]([^'"]+)['"]/);
  if (!match) return importLine.replace(/;\s*$/, '');

  let modulePath = match[1];
  if (!modulePath.startsWith('.')) return importLine.replace(/;\s*$/, '');

  const fileDir = path.dirname(document.uri.fsPath);
  const absolutePath = path.resolve(fileDir, modulePath);
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return importLine.replace(/;\s*$/, '');

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  if (absolutePath.startsWith(workspaceRoot)) {
    const relativeToSrc = path.relative(path.join(workspaceRoot, 'src'), absolutePath);
    const normalizedPath = relativeToSrc.replace(/\\/g, '/');
    if (normalizedPath && !normalizedPath.startsWith('..')) {
      modulePath = `src/${normalizedPath}`;
    }
  }

  return importLine.replace(match[1], modulePath).replace(/;\s*$/, '');
}

async function groupAndSortImports(
  importPairs: { original: string; converted: string }[],
  document: vscode.TextDocument
): Promise<string> {
  const groupBuckets: Record<string, string[]> = {};
  GROUPS.forEach((g) => {
    groupBuckets[g.key] = [];
  });

  let remainingImports = [...importPairs];
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

  // Config
  remainingImports = remainingImports.filter((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (GROUPS.find((g) => g.key === 'config')!.match(modulePath, pair.converted)) {
      groupBuckets['config'].push(pair.converted);
      return false;
    }
    return true;
  });

  // src/ imports -- type/value separation
  const srcImports: { original: string; converted: string; position: number }[] = [];
  remainingImports.forEach((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (modulePath.startsWith('src/')) {
      const startIdx = document.getText().indexOf(pair.original);
      srcImports.push({ original: pair.original, converted: pair.converted, position: startIdx });
    }
  });
  remainingImports = remainingImports.filter((pair) => !getModulePathFromImport(pair.converted).startsWith('src/'));

  await Promise.all(
    srcImports.map(async ({ original, converted, position }) => {
      const modulePath = getModulePathFromImport(converted);

      // Default import
      const defaultImportMatch = converted.match(/import (\w+) from ['"]([^'"]+)['"]/);
      if (defaultImportMatch) {
        const identifier = defaultImportMatch[1];
        const identifierIndex = original.indexOf(identifier);
        const hoverPosition = document.positionAt(position + identifierIndex);
        const kind = await getSymbolScriptElementKind(document, hoverPosition, identifier);
        if (isSymbolATypeKind(kind)) {
          groupBuckets['types'].push(`import ${identifier} from '${modulePath}'`);
        } else {
          categorizeSrcImport(converted, modulePath, groupBuckets, kind);
        }
        return;
      }

      // Named imports
      const namedImportsMatch = converted.match(/import {([^}]+)} from ['"]([^'"]+)['"]/);
      if (namedImportsMatch) {
        const namedImports = namedImportsMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const startIdx = position;

        const symbolClassifications = await Promise.all(
          namedImports.map(async (name) => {
            const relativeIndex = original.indexOf(name);
            if (relativeIndex === -1) return { name, isType: false };
            const absoluteIndex = startIdx + relativeIndex;
            const hoverPosition = document.positionAt(absoluteIndex);
            const kind = await getSymbolScriptElementKind(document, hoverPosition, name);
            return { name, isType: isSymbolATypeKind(kind) };
          })
        );

        const typesToImport = symbolClassifications.filter((s) => s.isType).map((s) => s.name);
        const nonTypesToImport = symbolClassifications.filter((s) => !s.isType).map((s) => s.name);

        // Only types, only add the types import and return immediately.
        if (typesToImport.length > 0 && nonTypesToImport.length === 0) {
          const typesImportLine = formatImportStatement(typesToImport, modulePath, true);
          if (!groupBuckets['types'].includes(typesImportLine)) {
            groupBuckets['types'].push(typesImportLine);
          }
          return;
        }

        // Mixed: add both, then return
        if (typesToImport.length > 0 && nonTypesToImport.length > 0) {
          const typesImportLine = formatImportStatement(typesToImport, modulePath, true);
          if (!groupBuckets['types'].includes(typesImportLine)) {
            groupBuckets['types'].push(typesImportLine);
          }
          const nonTypesImportLine = formatImportStatement(nonTypesToImport, modulePath);
          categorizeSrcImport(nonTypesImportLine, modulePath, groupBuckets);
          return;
        }

        // Only value imports
        if (nonTypesToImport.length > 0) {
          const nonTypesImportLine = formatImportStatement(nonTypesToImport, modulePath);
          categorizeSrcImport(nonTypesImportLine, modulePath, groupBuckets);
        }
        return;
      }

      categorizeSrcImport(converted, modulePath, groupBuckets);
    })
  );

  // All remaining imports
  remainingImports.forEach((pair) => {
    groupBuckets['other'].push(pair.converted);
  });

  // Format groups
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

function categorizeSrcImport(
  importLine: string,
  modulePath: string,
  buckets: Record<string, string[]>,
  kind?: ts.ScriptElementKind
) {
  for (const group of GROUPS) {
    if (group.key === 'types' && isSymbolATypeKind(kind)) {
      buckets[group.key].push(importLine);
      return;
    }
    if (['types', 'other'].includes(group.key)) continue;
    if (group.match(modulePath, importLine)) {
      buckets[group.key].push(importLine);
      return;
    }
  }
  buckets['other'].push(importLine);
}

function getImportRange(document: vscode.TextDocument, imports: string[]): vscode.Range | null {
  if (!imports.length) return null;
  const text = document.getText();

  const firstImportString = imports[0];
  const lastImportString = imports[imports.length - 1];

  const firstImportMatchIndex = text.indexOf(firstImportString);
  if (firstImportMatchIndex === -1) {
    // Should ideally not happen if imports array is populated from the same document
    return null;
  }

  const lastImportMatchIndex = text.lastIndexOf(lastImportString);
  if (lastImportMatchIndex === -1) {
    // Should ideally not happen
    return null;
  }

  const lastImportLength = lastImportString.length;
  const lastImportEndIndex = lastImportMatchIndex + lastImportLength;

  let firstImportLineNum = document.positionAt(firstImportMatchIndex).line;
  // Scan upwards from the first import to include preceding blank lines or group comments
  while (firstImportLineNum > 0) {
    const currentLine = document.lineAt(firstImportLineNum - 1);
    const trimmedText = currentLine.text.trim();
    if (trimmedText === '' || (trimmedText.startsWith('// ** ') && trimmedText.endsWith(' Imports'))) {
      firstImportLineNum--;
    } else {
      break; // Found a non-empty, non-comment line, or reached the top
    }
  }

  const rangeStart = document.lineAt(firstImportLineNum).range.start;

  // Determine the end of the range
  const trailingText = text.slice(lastImportEndIndex); // Text from the end of the last import string to EOF
  const onlyWhitespaceAfter = /^\s*$/.test(trailingText); // True if that text is only whitespace

  let rangeEnd: vscode.Position;
  if (onlyWhitespaceAfter) {
    // If only whitespace follows the import block, the range extends to the end of the document.
    // This ensures that all trailing newlines after the import block are part of the replacement.
    rangeEnd = document.lineAt(document.lineCount - 1).range.end;
  } else {
    // If there is substantive content after the import block,
    // the range must end precisely after the last character of the last import string.
    // This correctly handles multi-line import statements.
    rangeEnd = document.positionAt(lastImportEndIndex);
  }

  return new vscode.Range(rangeStart, rangeEnd);
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand('importFormatter.organizeImports', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const text = document.getText();
    const importRegex = /^import[\s\S]*?from\s*['"][^'"]+['"];?/gm;
    const importMatches = [...text.matchAll(importRegex)];
    const originalImports = importMatches.map((m) => m[0].trim());

    if (!originalImports.length) return;

    const importPairs = await Promise.all(
      originalImports.map(async (imp) => {
        const converted = await convertRelativeImportsToAbsolute(imp, document);
        return { original: imp, converted };
      })
    );

    const groupedAndSortedImports = await groupAndSortImports(importPairs, document);

    const importRange = getImportRange(document, originalImports);
    if (!importRange) return;

    await editor.edit((editBuilder) => {
      editBuilder.replace(importRange, groupedAndSortedImports);
    });

    await document.save();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
