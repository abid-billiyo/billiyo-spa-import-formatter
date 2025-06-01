import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';

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

      if (/\binterface\b/.test(hoverContent)) return ts.ScriptElementKind.interfaceElement;
      if (/\btype\b|\(alias\)\s*type\s+\w+/.test(hoverContent)) return ts.ScriptElementKind.typeElement;
      if (/\benum\b/.test(hoverContent)) return ts.ScriptElementKind.enumElement;
      if (/\bclass\b/.test(hoverContent)) return ts.ScriptElementKind.classElement;
      if (/\bnamespace\b/.test(hoverContent)) return ts.ScriptElementKind.moduleElement;
      if (/\bfunction\b/.test(hoverContent)) return ts.ScriptElementKind.functionElement;
      if (/\b(const|let|var)\b/.test(hoverContent)) return ts.ScriptElementKind.variableElement;
      if (/\b(React\.FC|React\.ComponentType|JSX\.Element|elementType)\b/.test(hoverContent))
        return ts.ScriptElementKind.functionElement;
    }
  } catch (e) {
    console.error(`Error fetching hover for ${symbolName}:`, e);
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
  const componentRegex = /import {([^}]+)} from ['"]@mui\/(material|icons-material)[''];?/;
  const match = importLine.match(componentRegex);
  if (!match) return [importLine.replace(/;\s*$/, '')];

  const namedImports = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
  const modulePath = match[2];

  const allAreComponents = namedImports.every((imp) => /^[A-Z]/.test(imp) && !imp.endsWith('Props'));
  if (allAreComponents) {
    return namedImports.map((imp) => `import ${imp} from '@mui/${modulePath}/${imp}'`);
  } else {
    return [importLine.replace(/;\s*$/, '')];
  }
}

function getModulePathFromImport(importLine: string): string {
  const match = importLine.match(/from\s*['"]([^'"]+)['"];?/);
  if (match && match[1]) return match[1];
  const directImportMatch = importLine.match(/^import\s*['"]([^'"]+)['"];?/);
  if (directImportMatch && directImportMatch[1]) return directImportMatch[1];
  return '';
}

function formatImportStatement(imports: string[], modulePath: string): string {
  const importList = imports.join(', ');
  const singleLine = `import { ${importList} } from '${modulePath}'`;

  // Single-import statements stay single-line, regardless of length
  if (imports.length === 1) {
    return singleLine;
  }

  // For multiple imports, format as multi-line if exceeds printWidth (120)
  if (singleLine.length > 120) {
    const sortedImports = imports.sort((a, b) => a.length - b.length);
    const formattedImports = sortedImports.map((imp) => `  ${imp}`).join(',\n');
    return `import {\n${formattedImports}\n} from '${modulePath}'`;
  }

  return singleLine;
}

async function convertRelativeImportsToAbsolute(importLine: string, document: vscode.TextDocument): Promise<string> {
  const match = importLine.match(/from\s*['"]([^'"]+)['"];?/);
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
    if (!relativeToSrc.startsWith('..')) {
      modulePath = `src/${relativeToSrc.replace(/\\/g, '/')}`;
    }
  }

  return importLine.replace(match[1], modulePath).replace(/;\s*$/, '');
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
    local: [],
    utils: [],
    unknown: [],
  };

  const documentText = document.getText();

  for (let imp of imports) {
    imp = imp.replace(/;\s*$/, '');
    const modulePath = getModulePathFromImport(imp);

    if (imp.startsWith('import type')) {
      groups.types.push(imp);
      continue;
    }

    const defaultImportMatch = imp.match(/import (\w+) from ['"]([^'"]+)['']/);
    if (defaultImportMatch) {
      const identifier = defaultImportMatch[1];
      const startIdx = documentText.indexOf(imp);
      const identifierIndex = imp.indexOf(identifier);
      const position = document.positionAt(startIdx + identifierIndex);
      const kind = await getSymbolScriptElementKind(document, position, identifier);
      if (isSymbolATypeKind(kind)) {
        groups.types.push(imp);
      } else {
        categorizeImport(imp, modulePath, groups);
      }
      continue;
    }

    const namedImportsMatch = imp.match(/import {([^}]+)} from ['"]([^'"]+)['']/);
    if (namedImportsMatch && modulePath.startsWith('src/')) {
      const namedImports = namedImportsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s);
      const startIdx = documentText.indexOf(imp);

      const symbolClassifications = await Promise.all(
        namedImports.map(async (name) => {
          const relativeIndex = imp.indexOf(name);
          if (relativeIndex === -1) return { name, isType: false };
          const absoluteIndex = startIdx + relativeIndex;
          const position = document.positionAt(absoluteIndex);
          const kind = await getSymbolScriptElementKind(document, position, name);
          return { name, isType: isSymbolATypeKind(kind) };
        })
      );

      const typesToImport = symbolClassifications.filter((s) => s.isType).map((s) => s.name);
      const nonTypesToImport = symbolClassifications.filter((s) => !s.isType).map((s) => s.name);

      if (typesToImport.length > 0) {
        const typesImportLine = formatImportStatement(typesToImport, modulePath);
        groups.types.push(typesImportLine);
      }

      if (nonTypesToImport.length > 0) {
        const nonTypesImportLine = formatImportStatement(nonTypesToImport, modulePath);
        categorizeImport(nonTypesImportLine, modulePath, groups);
      }
    } else {
      categorizeImport(imp, modulePath, groups);
    }
  }

  const formatGroup = (label: string, lines: string[]): string[] => {
    if (!lines.length) return [];
    const multiLineImports = lines.filter((line) => line.includes('\n'));
    const singleLineImports = lines.filter((line) => !line.includes('\n'));
    multiLineImports.sort((a, b) => a.length - b.length);
    singleLineImports.sort((a, b) => a.length - b.length);
    return [`// ** ${label} Imports`, ...multiLineImports, ...singleLineImports];
  };

  const finalOutput: string[] = [];
  let firstGroup = true;
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
    const groupKey = label.toLowerCase().replace(/\s/g, '');
    const groupLines = formatGroup(label, groups[groupKey]);
    if (groupLines.length > 0) {
      if (!firstGroup) finalOutput.push('');
      finalOutput.push(...groupLines);
      firstGroup = false;
    }
  }

  return finalOutput.join('\n');
}

function categorizeImport(importLine: string, modulePath: string, groups: Record<string, string[]>) {
  if (modulePath.startsWith('next/')) {
    groups.next.push(importLine);
  } else if (/react-(redux|hook-form)|react-hot-toast|redux/.test(modulePath)) {
    groups.thirdparty.push(importLine);
  } else if (modulePath.startsWith('react')) {
    groups.react.push(importLine);
  } else if (modulePath.startsWith('@mui/')) {
    const transformed = transformMuiImport(importLine);
    groups.mui.push(...transformed);
  } else if (modulePath.startsWith('src/store/')) {
    groups.reduxstore.push(importLine);
  } else if (modulePath.startsWith('src/api-clients/')) {
    groups.api.push(importLine);
  } else if (modulePath.includes('/hooks')) {
    groups.hooks.push(importLine);
  } else if (modulePath.includes('/utils')) {
    groups.utils.push(importLine);
  } else if (modulePath.startsWith('src/')) {
    groups.local.push(importLine);
  } else {
    groups.unknown.push(importLine);
  }
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand('importFormatter.organizeImports', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const text = document.getText();

    const importRegex = /^import(?:["'\s]*(?:[\w*{}\n\r\t, ]+)from\s*)?["'`].*["'`];?\s*$/gm;
    const importMatches = [...text.matchAll(importRegex)];
    const originalImports = importMatches.map((m) => m[0].trim());

    if (!originalImports.length) return;

    const convertedImports = await Promise.all(
      originalImports.map((imp) => convertRelativeImportsToAbsolute(imp, document))
    );
    const groupedAndSortedImports = await groupAndSortImports(convertedImports, document);

    const firstImportMatchIndex = text.indexOf(originalImports[0]);
    const lastImportMatchIndex = text.lastIndexOf(originalImports[originalImports.length - 1]);

    const firstImportLineNum = document.positionAt(firstImportMatchIndex).line;
    const lastImportLineNum = document.positionAt(lastImportMatchIndex).line;

    let replacementStartLine = firstImportLineNum;
    while (replacementStartLine > 0) {
      const currentLine = document.lineAt(replacementStartLine - 1);
      const trimmedText = currentLine.text.trim();
      if (trimmedText === '' || (trimmedText.startsWith('// ** ') && trimmedText.endsWith(' Imports'))) {
        replacementStartLine--;
      } else {
        break;
      }
    }

    const fullRange = new vscode.Range(
      document.lineAt(replacementStartLine).range.start,
      document.lineAt(lastImportLineNum).range.end
    );

    await editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, groupedAndSortedImports);
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
