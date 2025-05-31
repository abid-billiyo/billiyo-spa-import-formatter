import * as vscode from 'vscode';
import * as ts from 'typescript';

/**
 * Transforms a single MUI import line with named imports into individual default imports,
 * but only if all named imports appear to be components.
 */
function transformMuiImport(importLine: string): string[] {
  const componentRegex =
    /import {([^}]+)} from ['"]@mui\/(material|icons-material)['"];?/;
  const match = importLine.match(componentRegex);
  if (!match) return [importLine];

  const namedImports = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
  const modulePath = match[2];

  const allAreComponents = namedImports.every(
    (imp) => /^[A-Z]/.test(imp) && !imp.endsWith('Props')
  );
  if (allAreComponents) {
    return namedImports.map(
      (imp) => `import ${imp} from '@mui/${modulePath}/${imp}';`
    );
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
      const hoverContent = hovers[0].contents
        .map((c) => (typeof c === 'string' ? c : c.value))
        .join('\n');

      // console.log(`--- TSLS Debugging for "${symbolName}" ---`);
      // console.log(`Hover Content for "${symbolName}":\n${hoverContent.substring(0, 200)}...`);

      let inferredKind: ts.ScriptElementKind | undefined;

      // Improved regexes for type definitions (interface, type alias, enum, class, namespace)
      // Added (alias) type for more robust detection
      if (
        /\b(interface|type|enum|class|namespace)\b\s+\w+/.test(hoverContent) ||
        /\(alias\)\s*type\s+\w+/.test(hoverContent)
      ) {
        if (/\binterface\b/.test(hoverContent))
          inferredKind = ts.ScriptElementKind.interfaceElement;
        else if (/\btype\b|\(alias\)\s*type\s+\w+/.test(hoverContent))
          inferredKind = ts.ScriptElementKind.typeElement;
        else if (/\benum\b/.test(hoverContent))
          inferredKind = ts.ScriptElementKind.enumElement;
        else if (/\bclass\b/.test(hoverContent))
          inferredKind =
            ts.ScriptElementKind
              .classElement; // Class can be a type (e.g. for typeof)
        else if (/\bnamespace\b/.test(hoverContent))
          inferredKind = ts.ScriptElementKind.moduleElement;
      }
      // Check for value/function definitions
      else if (
        /\b(const|let|var)\b\s+\w+\s*:\s*\S+/.test(hoverContent) ||
        /\bfunction\b\s+\w+\s*\(/.test(hoverContent)
      ) {
        if (/\bfunction\b/.test(hoverContent))
          inferredKind = ts.ScriptElementKind.functionElement;
        else inferredKind = ts.ScriptElementKind.variableElement;
      }
      // Special handling for React components (often appear as functions or variables with specific types)
      else if (
        /\b(React\.FC|React\.ComponentType|JSX\.Element|elementType)\b/.test(
          hoverContent
        )
      ) {
        inferredKind = ts.ScriptElementKind.functionElement; // Treat React components as functions for grouping purposes
      }

      // console.log(`Inferred Kind for "${symbolName}": ${inferredKind ? ts.ScriptElementKind[inferredKind] : 'undefined'}`);
      return inferredKind;
    }
  } catch (e) {
    console.error(
      `Error querying TSLS for "${symbolName}" at ${position.line}:${position.character}:`,
      e
    );
  }
  // console.log(`No hover content or kind inferred for "${symbolName}". Returning undefined.`);
  return undefined;
}

/**
 * Determines if a symbol's ScriptElementKind indicates it is a type.
 */
function isSymbolATypeKind(kind: ts.ScriptElementKind | undefined): boolean {
  if (kind === undefined) {
    // console.log(`Kind is undefined, not a type.`);
    return false;
  }

  // console.log(`Checking kind: ${ts.ScriptElementKind[kind]}`);

  const isType =
    kind === ts.ScriptElementKind.interfaceElement ||
    kind === ts.ScriptElementKind.typeElement || // Covers `type Alias = ...`
    kind === ts.ScriptElementKind.enumElement ||
    kind === ts.ScriptElementKind.classElement || // Classes can be used as types (e.g., `typeof MyClass`)
    kind === ts.ScriptElementKind.moduleElement || // Namespaces/Modules can contain types (e.g., `namespace MyTypes { ... }`)
    kind === ts.ScriptElementKind.enumMemberElement ||
    kind === ts.ScriptElementKind.typeParameterElement;
  // console.log(`Kind ${ts.ScriptElementKind[kind]} is a type: ${isType}`);
  return isType;
}

export async function groupAndSortImports(
  imports: string[],
  document: vscode.TextDocument
): Promise<string> {
  const groups: Record<string, string[]> = {
    next: [],
    react: [],
    mui: [],
    thirdParty: [],
    redux: [],
    types: [],
    reduxStore: [],
    api: [],
    hooks: [],
    utils: [], // 'utils' is back as a distinct group
    local: [],
    unknown: []
  };

  const importQueue: string[] = [...imports];
  const documentText = document.getText();

  while (importQueue.length > 0) {
    const imp = importQueue.shift()!;

    const namedImportsMatch = imp.match(
      /import {([^}]+)} from ['"]([^'"]+)['"];?/
    );
    const modulePath = namedImportsMatch ? namedImportsMatch[2] : '';

    const isFromSrc = /from ['"]src\//.test(imp);
    const isFromStore = /from ['"]src\/store\//.test(imp);
    const isFromApiClients = /from ['"]src\/api-clients\//.test(imp);
    const isFromHooks = /from ['"].*\/hooks\//.test(imp);
    const isFromUtils = /from ['"].*\/utils\//.test(imp);
    const isDtsFile = /\.d\.ts['"]/.test(imp);

    // --- Handle TSLS analysis and splitting for SRC named imports ---
    if (namedImportsMatch && isFromSrc) {
      const namedImports = namedImportsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s);

      let typesToImport: string[] = [];
      let nonTypesToImport: string[] = [];

      const impLineStartPos = document.positionAt(documentText.indexOf(imp));
      const importLineFoundInDocument = impLineStartPos.line !== -1;

      if (namedImports.length > 0 && importLineFoundInDocument) {
        const importLineNumber = impLineStartPos.line;
        const currentLineText = document.lineAt(importLineNumber).text;

        const symbolClassifications = await Promise.all(
          namedImports.map(async (name) => {
            const startCharInLine = currentLineText.indexOf(name);
            if (startCharInLine === -1) {
              console.warn(
                `[WARN] Named import "${name}" not found in line text: "${currentLineText}". Cannot perform TSLS check.`
              );
              return { name, isType: false };
            }
            const position = new vscode.Position(
              importLineNumber,
              startCharInLine
            );
            const kind = await getSymbolScriptElementKind(
              document,
              position,
              name
            );
            return { name, isType: isSymbolATypeKind(kind) };
          })
        );

        typesToImport = symbolClassifications
          .filter((s) => s.isType)
          .map((s) => s.name);
        nonTypesToImport = symbolClassifications
          .filter((s) => !s.isType)
          .map((s) => s.name);

        if (typesToImport.length > 0 && nonTypesToImport.length > 0) {
          // Split the import line if it contains both types and non-types
          groups.types.push(
            `import { ${typesToImport.join(', ')} } from '${modulePath}';`
          );

          const nonTypeImportLine = `import { ${nonTypesToImport.join(
            ', '
          )} } from '${modulePath}';`;
          if (isFromStore) {
            groups.reduxStore.push(nonTypeImportLine);
          } else if (isFromApiClients) {
            groups.api.push(nonTypeImportLine);
          } else if (isFromHooks) {
            groups.hooks.push(nonTypeImportLine);
          } else if (isFromUtils) {
            // Utils part of split goes to its own group
            groups.utils.push(nonTypeImportLine);
          } else {
            groups.local.push(nonTypeImportLine);
          }
          continue; // Move to the next original import, as this one has been processed and split
        }
      }
    }
    // --- End TSLS analysis and splitting for SRC named imports ---

    // --- General Grouping Logic for all remaining (unsplit or external) imports ---
    if (/from ['"]next\//.test(imp)) {
      groups.next.push(imp);
    } else if (/from ['"]react-(redux|hook-form)|react-hot-toast/.test(imp)) {
      groups.thirdParty.push(imp);
    } else if (/from ['"]react/.test(imp)) {
      groups.react.push(imp);
    } else if (/from ['"]@mui\//.test(imp)) {
      const transformedImports = transformMuiImport(imp);
      groups.mui.push(...transformedImports);
    }
    // ====================================================================================
    // SRC-based Grouping (for pure lines or defaults)
    // ====================================================================================
    else if (isFromSrc) {
      let isCurrentLinePurelyTypes = false;

      if (isDtsFile) {
        isCurrentLinePurelyTypes = true;
      } else if (namedImportsMatch) {
        const currentImpNamedImports = namedImportsMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s);
        const currentImpLineStartPos = document.positionAt(
          documentText.indexOf(imp)
        );
        if (currentImpLineStartPos.line !== -1) {
          const currentImpLineNumber = currentImpLineStartPos.line;
          const currentImpLineText = document.lineAt(currentImpLineNumber).text;

          const currentImpSymbolClassifications = await Promise.all(
            currentImpNamedImports.map(async (name) => {
              const startCharInLine = currentImpLineText.indexOf(name);
              if (startCharInLine === -1) return { name, isType: false };
              const position = new vscode.Position(
                currentImpLineNumber,
                startCharInLine
              );
              const kind = await getSymbolScriptElementKind(
                document,
                position,
                name
              );
              return { name, isType: isSymbolATypeKind(kind) };
            })
          );
          isCurrentLinePurelyTypes = currentImpSymbolClassifications.every(
            (s) => s.isType
          );
        }
      }

      if (isCurrentLinePurelyTypes) {
        groups.types.push(imp);
      } else if (isFromStore) {
        groups.reduxStore.push(imp);
      } else if (isFromApiClients) {
        groups.api.push(imp);
      } else if (isFromHooks) {
        groups.hooks.push(imp);
      } else if (isFromUtils) {
        // Pure utils imports go to their own group
        groups.utils.push(imp);
      } else {
        // Fallback for all other src/ imports
        groups.local.push(imp);
      }
    } else {
      // Non-src, non-recognized external imports
      groups.unknown.push(imp);
    }
  }

  const formatGroup = (label: string, lines: string[]): string[] => {
    if (!lines.length) return [];
    const sorted = lines.sort((a: string, b: string) => a.length - b.length);
    return [`// ** ${label} Imports`, ...sorted, ''];
  };

  return [
    ...formatGroup('Next', groups.next),
    ...formatGroup('React', groups.react),
    ...formatGroup('MUI', groups.mui),
    ...formatGroup('Third Party', groups.thirdParty),
    ...formatGroup('Redux', groups.redux),
    ...formatGroup('Types', groups.types),
    ...formatGroup('Redux Store', groups.reduxStore),
    ...formatGroup('API', groups.api),
    ...formatGroup('Hooks', groups.hooks),
    ...formatGroup('Local', groups.local), // Local imports first
    ...formatGroup('Utils', groups.utils), // Then Utils imports
    ...formatGroup('Unknown', groups.unknown)
  ].join('\n');
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    'importGrouper.organizeImports',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const text = document.getText();

      // Regex to capture full import statements
      const importRegex =
        /^import(?:["'\s]*(?:[\w*{}\n\r\t, ]+)from\s*)?["'`].*["'`];?\s*$/gm;

      const importMatches = [...text.matchAll(importRegex)].map((m) =>
        m[0].trim()
      );

      if (!importMatches.length) return;

      const groupedImports = await groupAndSortImports(importMatches, document);

      const firstImportMatchIndex = text.indexOf(importMatches[0]);
      const lastImportMatchIndex = text.lastIndexOf(
        importMatches[importMatches.length - 1]
      );

      const startPosition = document.positionAt(firstImportMatchIndex);
      const endPosition = document.positionAt(
        lastImportMatchIndex + importMatches[importMatches.length - 1].length
      );

      const fullRange = new vscode.Range(
        document.lineAt(startPosition.line).range.start,
        document.lineAt(endPosition.line).range.end
      );

      editor.edit((editBuilder) => {
        editBuilder.replace(fullRange, groupedImports);
      });
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
