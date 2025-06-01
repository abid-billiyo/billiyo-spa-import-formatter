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

    console.log(`Hover position for ${symbolName}: Line ${position.line}, Character ${position.character}`);

    if (hovers && hovers.length > 0) {
      const hoverContent = hovers[0].contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
      console.log(`Hover content for ${symbolName}: ${hoverContent}`);

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
  const styleImportRegex = /import {([^}]+)} from ['"]@mui\/material['']/;
  const styleMatch = importLine.match(styleImportRegex);
  if (styleMatch) {
    const namedImports = styleMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s);
    if (namedImports.some((imp) => ['Theme', 'SxProps', 'useTheme', 'styled'].includes(imp))) {
      return [importLine.replace('@mui/material', '@mui/material/styles').replace(/;\s*$/, '')];
    }
  }

  const componentRegex = /import {([^}]+)} from ['"]@mui\/(material|icons-material)['']/;
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
  const match = importLine.match(/from\s*['"]([^'"]+)['"]/);
  if (match && match[1]) return match[1];
  const directImportMatch = importLine.match(/^import\s*['"]([^'"]+)['"]/);
  if (directImportMatch && directImportMatch[1]) return directImportMatch[1];
  return '';
}

function formatImportStatement(imports: string[], modulePath: string): string {
  const importList = imports.join(', ');
  const singleLine = `import { ${importList} } from '${modulePath}'`;

  if (imports.length === 1) {
    return singleLine;
  }

  if (singleLine.length > 120) {
    const sortedImports = imports.sort((a, b) => a.length - b.length);
    const formattedImports = sortedImports.map((imp) => `  ${imp}`).join(',\n');
    return `import {\n${formattedImports}\n} from '${modulePath}'`;
  }

  return singleLine;
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
    if (normalizedPath) {
      modulePath = `src/${normalizedPath}`;
    }
  }

  const convertedImport = importLine.replace(match[1], modulePath).replace(/;\s*$/, '');
  console.log(`Converted ${importLine} to ${convertedImport}`);
  return convertedImport;
}

async function groupAndSortImports(
  importPairs: { original: string; converted: string }[],
  document: vscode.TextDocument
): Promise<string> {
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
    config: [],
    other: [],
  };

  let remainingImports = [...importPairs];

  remainingImports = remainingImports.filter((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (modulePath.startsWith('next/')) {
      groups.next.push(pair.converted);
      return false;
    }
    return true;
  });

  remainingImports = remainingImports.filter((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (modulePath === 'react') {
      groups.react.push(pair.converted);
      return false;
    }
    return true;
  });

  remainingImports = remainingImports.filter((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (modulePath.startsWith('@mui/')) {
      const transformed = transformMuiImport(pair.converted);
      groups.mui.push(...transformed);
      return false;
    }
    return true;
  });

  remainingImports = remainingImports.filter((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (
      !modulePath.startsWith('src/') &&
      modulePath !== 'react' &&
      !modulePath.startsWith('next/') &&
      !modulePath.startsWith('@mui/')
    ) {
      groups.thirdparty.push(pair.converted);
      return false;
    }
    return true;
  });

  remainingImports = remainingImports.filter((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (modulePath.startsWith('src/configs')) {
      groups.config.push(pair.converted);
      return false;
    }
    return true;
  });

  const srcImports: { original: string; converted: string; position: number }[] = [];
  remainingImports.forEach((pair) => {
    const modulePath = getModulePathFromImport(pair.converted);
    if (modulePath.startsWith('src/')) {
      const startIdx = document.getText().indexOf(pair.original);
      srcImports.push({ original: pair.original, converted: pair.converted, position: startIdx });
    }
  });
  remainingImports = remainingImports.filter((pair) => !getModulePathFromImport(pair.converted).startsWith('src/'));

  for (const { original, converted, position } of srcImports) {
    const modulePath = getModulePathFromImport(converted);

    if (converted.startsWith('import type')) {
      groups.types.push(converted);
      continue;
    }

    const defaultImportMatch = converted.match(/import (\w+) from ['"]([^'"]+)['"]/);
    if (defaultImportMatch) {
      const identifier = defaultImportMatch[1];
      const identifierIndex = original.indexOf(identifier);
      const hoverPosition = document.positionAt(position + identifierIndex);
      const kind = await getSymbolScriptElementKind(document, hoverPosition, identifier);
      console.log(
        `Default import: ${converted}, Kind: ${kind}, Position: ${hoverPosition.line},${hoverPosition.character}`
      );
      if (isSymbolATypeKind(kind)) {
        groups.types.push(converted);
      } else {
        categorizeSrcImport(converted, modulePath, groups, kind);
      }
      continue;
    }

    const namedImportsMatch = converted.match(/import {([^}]+)} from ['"]([^'"]+)['"]/);
    if (namedImportsMatch) {
      const namedImports = namedImportsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s);
      const startIdx = position;

      const symbolClassifications = await Promise.all(
        namedImports.map(async (name) => {
          const relativeIndex = original.indexOf(name);
          if (relativeIndex === -1) return { name, isType: false };
          const absoluteIndex = startIdx + relativeIndex;
          const hoverPosition = document.positionAt(absoluteIndex);
          const kind = await getSymbolScriptElementKind(document, hoverPosition, name);
          console.log(
            `Named import: ${name} from ${modulePath}, Kind: ${kind}, Position: ${hoverPosition.line},${hoverPosition.character}`
          );
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
        categorizeSrcImport(nonTypesImportLine, modulePath, groups);
      }
    } else {
      categorizeSrcImport(converted, modulePath, groups);
    }
  }

  remainingImports.forEach((pair) => {
    groups.other.push(pair.converted);
  });

  const formatGroup = (label: string, lines: string[]): string[] => {
    if (!lines.length) return [];
    const sortedImports = lines.sort((a, b) => {
      const getEffectiveLength = (imp: string) => {
        if (!imp.includes('\n')) return imp.length;
        const lines = imp.split('\n');
        const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
        return longestLine;
      };
      return getEffectiveLength(a) - getEffectiveLength(b);
    });
    return [`// ** ${label} Imports`, ...sortedImports];
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
    'Config',
    'Utils',
    'Other',
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

function categorizeSrcImport(
  importLine: string,
  modulePath: string,
  groups: Record<string, string[]>,
  kind?: ts.ScriptElementKind
) {
  console.log(`Categorizing src import: ${importLine}, Module: ${modulePath}, Kind: ${kind}`);
  if (modulePath.startsWith('src/store/')) {
    groups.reduxstore.push(importLine);
  } else if (modulePath.startsWith('src/api-clients/') && (kind === undefined || !isSymbolATypeKind(kind))) {
    groups.api.push(importLine);
  } else if (modulePath.includes('/hooks')) {
    groups.hooks.push(importLine);
  } else if (modulePath.includes('/utils')) {
    groups.utils.push(importLine);
  } else if (modulePath.startsWith('src/') && isSymbolATypeKind(kind)) {
    groups.types.push(importLine);
  } else if (modulePath.startsWith('src/')) {
    groups.local.push(importLine);
  } else {
    groups.other.push(importLine);
  }
}

function getImportRange(document: vscode.TextDocument, imports: string[]): vscode.Range | null {
  if (!imports.length) return null;

  const text = document.getText();
  const firstImportMatchIndex = text.indexOf(imports[0]);
  const lastImportMatchIndex = text.lastIndexOf(imports[imports.length - 1]);

  let firstImportLineNum = document.positionAt(firstImportMatchIndex).line;
  const lastImportLineNum = document.positionAt(lastImportMatchIndex).line;

  while (firstImportLineNum > 0) {
    const currentLine = document.lineAt(firstImportLineNum - 1);
    const trimmedText = currentLine.text.trim();
    if (trimmedText === '' || (trimmedText.startsWith('// ** ') && trimmedText.endsWith(' Imports'))) {
      firstImportLineNum--;
    } else {
      break;
    }
  }

  return new vscode.Range(
    document.lineAt(firstImportLineNum).range.start,
    document.lineAt(lastImportLineNum).range.end
  );
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

    // Create pairs of original and converted imports
    const importPairs = await Promise.all(
      originalImports.map(async (imp) => {
        const converted = await convertRelativeImportsToAbsolute(imp, document);
        return { original: imp, converted };
      })
    );
    console.log('Import Pairs:', importPairs);

    // Group and sort imports
    const groupedAndSortedImports = await groupAndSortImports(importPairs, document);

    // Replace imports in one edit operation
    const importRange = getImportRange(document, originalImports);
    if (!importRange) return;

    await editor.edit((editBuilder) => {
      editBuilder.replace(importRange, groupedAndSortedImports);
    });

    // Auto-save the file after formatting
    await document.save();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
