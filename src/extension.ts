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

      // More flexible matching for types
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
    } else {
      // Fallback: Map to src/api-clients/ if no direct src/ mapping
      const relativeToApiClients = path.relative(path.join(workspaceRoot, 'src', 'api-clients'), absolutePath);
      if (relativeToApiClients && !relativeToApiClients.startsWith('..')) {
        modulePath = `src/api-clients/${relativeToApiClients.replace(/\\/g, '/')}`;
      }
    }
  }

  const convertedImport = importLine.replace(match[1], modulePath).replace(/;\s*$/, '');
  console.log(`Converted ${importLine} to ${convertedImport}`);
  return convertedImport;
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
    other: [],
  };

  let remainingImports = [...imports];

  // Step 1: Filter Next.js Imports
  remainingImports = remainingImports.filter((imp) => {
    const modulePath = getModulePathFromImport(imp);
    if (modulePath.startsWith('next/')) {
      groups.next.push(imp);
      return false;
    }
    return true;
  });

  // Step 2: Filter React Imports (only from 'react')
  remainingImports = remainingImports.filter((imp) => {
    const modulePath = getModulePathFromImport(imp);
    if (modulePath === 'react') {
      groups.react.push(imp);
      return false;
    }
    return true;
  });

  // Step 3: Filter MUI Imports
  remainingImports = remainingImports.filter((imp) => {
    const modulePath = getModulePathFromImport(imp);
    if (modulePath.startsWith('@mui/')) {
      const transformed = transformMuiImport(imp);
      groups.mui.push(...transformed);
      return false;
    }
    return true;
  });

  // Step 4: Filter Third Party Imports (all non-src/, non-next/, non-react, non-mui/)
  remainingImports = remainingImports.filter((imp) => {
    const modulePath = getModulePathFromImport(imp);
    if (
      !modulePath.startsWith('src/') &&
      modulePath !== 'react' &&
      !modulePath.startsWith('next/') &&
      !modulePath.startsWith('@mui/')
    ) {
      groups.thirdparty.push(imp);
      return false;
    }
    return true;
  });

  // Step 5: Process src/* Imports for Type Detection
  const srcImports: { imp: string; originalImp: string; position: number }[] = [];
  remainingImports.forEach((imp, index) => {
    const modulePath = getModulePathFromImport(imp);
    if (modulePath.startsWith('src/')) {
      const startIdx = document.getText().indexOf(imp);
      srcImports.push({ imp, originalImp: imp, position: startIdx });
    }
  });
  remainingImports = remainingImports.filter((imp) => !getModulePathFromImport(imp).startsWith('src/'));

  // Process src/* imports for type detection
  for (const { imp, originalImp, position } of srcImports) {
    const modulePath = getModulePathFromImport(imp);

    if (imp.startsWith('import type')) {
      groups.types.push(imp);
      continue;
    }

    const defaultImportMatch = imp.match(/import (\w+) from ['"]([^'"]+)['']/);
    if (defaultImportMatch) {
      const identifier = defaultImportMatch[1];
      const identifierIndex = originalImp.indexOf(identifier);
      const hoverPosition = document.positionAt(position + identifierIndex);
      const kind = await getSymbolScriptElementKind(document, hoverPosition, identifier);
      console.log(`Default import: ${imp}, Kind: ${kind}, Position: ${hoverPosition.line},${hoverPosition.character}`);
      const isLikelyTypePath =
        modulePath.endsWith('/types') ||
        (modulePath.startsWith('src/api-clients/') && !modulePath.includes('apiClientBuilders'));
      if (isSymbolATypeKind(kind) || (kind === undefined && isLikelyTypePath)) {
        groups.types.push(imp);
      } else {
        categorizeSrcImport(imp, modulePath, groups, kind);
      }
      continue;
    }

    const namedImportsMatch = imp.match(/import {([^}]+)} from ['"]([^'"]+)['']/);
    if (namedImportsMatch) {
      const namedImports = namedImportsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s);
      const startIdx = position;

      const symbolClassifications = await Promise.all(
        namedImports.map(async (name) => {
          const relativeIndex = originalImp.indexOf(name);
          if (relativeIndex === -1) return { name, isType: false };
          const absoluteIndex = startIdx + relativeIndex;
          const hoverPosition = document.positionAt(absoluteIndex);
          const kind = await getSymbolScriptElementKind(document, hoverPosition, name);
          console.log(
            `Named import: ${name} from ${modulePath}, Kind: ${kind}, Position: ${hoverPosition.line},${hoverPosition.character}`
          );
          const isLikelyTypePath =
            modulePath.endsWith('/types') ||
            (modulePath.startsWith('src/api-clients/') && !modulePath.includes('apiClientBuilders'));
          return { name, isType: isSymbolATypeKind(kind) || (kind === undefined && isLikelyTypePath) };
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
      categorizeSrcImport(imp, modulePath, groups);
    }
  }

  // Step 6: Categorize Remaining Imports (Other Imports)
  remainingImports.forEach((imp) => {
    groups.other.push(imp);
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
      const aLength = getEffectiveLength(a);
      const bLength = getEffectiveLength(b);
      return aLength - bLength;
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

    // Step 1: Convert all relative imports to absolute paths
    const convertedImports = await Promise.all(
      originalImports.map((imp) => convertRelativeImportsToAbsolute(imp, document))
    );
    console.log('Converted Imports:', convertedImports);

    // Step 2: Group and sort imports using the converted imports
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
