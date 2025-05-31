// src/extension.ts

import * as vscode from 'vscode';
import * as ts from 'typescript'; // Not directly used in this iteration, but useful for understanding TS concepts

/**
 * Transforms a single MUI import line with named imports into individual default imports,
 * but only if all named imports appear to be components.
 * e.g., "import { Typography, Button } from '@mui/material'"
 * becomes:
 * "import Typography from '@mui/material/Typography'"
 * "import Button from '@mui/material/Button'"
 *
 * Imports like "import { styled, useTheme } = '@mui/material/styles'" or
 * "import Box, { BoxProps } = '@mui/material/Box'" will remain unchanged.
 */
function transformMuiImport(importLine: string): string[] {
  // Regex to match named imports from @mui/material or @mui/icons-material
  const componentRegex =
    /import {([^}]+)} from ['"]@mui\/(material|icons-material)['"];?/;
  const match = importLine.match(componentRegex);

  if (!match) {
    return [importLine];
  }

  const namedImports = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
  const modulePath = match[2];

  // Check if all named imports are likely components (start with uppercase and don't end with 'Props')
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
 * Determines if a given named import is likely a type based on naming conventions (suffixes).
 * Used primarily for API types or other types where a specific /types folder isn't present.
 */
function isLikelyTypeImportWithSuffix(namedImport: string): boolean {
  const commonTypeSuffixes = [
    'Props',
    'Response',
    'Type',
    'Model',
    'Interface',
    'Schema',
    'Options',
    'Args'
  ]; // Added 'Options', 'Args'
  return (
    /^[A-Z][a-zA-Z0-9]*$/.test(namedImport) && // Must be PascalCase
    commonTypeSuffixes.some((suffix) => namedImport.endsWith(suffix))
  );
}

/**
 * Checks if ALL named imports in a line are PascalCase. This is a general heuristic.
 */
function areAllNamedImportsPascalCase(namedImports: string[]): boolean {
  return (
    namedImports.length > 0 &&
    namedImports.every((imp) => /^[A-Z][a-zA-Z0-9]*$/.test(imp))
  );
}

/**
 * Specifically identifies known Redux store types by name (e.g., AppDispatch, RootState).
 */
function isKnownStoreType(namedImport: string): boolean {
  const knownStoreTypes = [
    'AppDispatch',
    'RootState',
    'PayloadAction',
    'ThunkAction',
    'Action',
    'Dispatch'
  ];
  return knownStoreTypes.includes(namedImport);
}

export function groupAndSortImports(imports: string[]): string {
  const groups: Record<string, string[]> = {
    next: [],
    react: [],
    mui: [],
    thirdParty: [],
    redux: [], // This group is available if you have specific 'redux' core imports
    types: [],
    reduxStore: [],
    api: [],
    hooks: [],
    utils: [],
    local: [],
    unknown: []
  };

  for (const imp of imports) {
    const namedImportsMatch = imp.match(/import {([^}]+)} from/);
    const namedImports = namedImportsMatch
      ? namedImportsMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s)
      : [];

    // Determine characteristics of the import line to simplify conditions
    const isFromSrc = /from ['"]src\//.test(imp);
    const isFromStore = /from ['"]src\/store\//.test(imp);
    const isFromApiClients = /from ['"]src\/api-clients\//.test(imp);
    const isFromHooks = /from ['"].*\/hooks\//.test(imp);
    const isFromUtils = /from ['"].*\/utils\//.test(imp);
    const isDtsFile = /\.d\.ts['"]/.test(imp); // Checks if the import path ends with .d.ts

    // Determine type characteristics based on named imports
    const allArePascalCase = areAllNamedImportsPascalCase(namedImports);
    const hasSuffixType = namedImports.some(isLikelyTypeImportWithSuffix);
    const hasKnownStoreType = namedImports.some(isKnownStoreType);

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
    // CRITICAL RE-ORDERED SOURCE-BASED IMPORT CHECKS
    // More specific src/ paths / type indicators are checked BEFORE broader src/ paths.
    // ====================================================================================

    // 1. Broadest Type Check for any 'src/' import:
    // This is the primary type classification. It needs to come before other
    // functional groups like hooks, utils, reduxStore, api, or general local.
    else if (
      isFromSrc &&
      (isDtsFile || allArePascalCase || hasSuffixType || hasKnownStoreType)
    ) {
      groups.types.push(imp);
    }
    // 2. Redux Store specific imports (action creators, reducers, etc. - non-type)
    // This catches src/store/ imports that were NOT identified as types by the above rule.
    else if (isFromStore) {
      groups.reduxStore.push(imp);
    }
    // 3. API client functions/constants (non-type)
    // This catches src/api-clients/ that were NOT identified as types.
    else if (isFromApiClients) {
      groups.api.push(imp);
    }
    // 4. Hooks imports
    else if (isFromHooks) {
      groups.hooks.push(imp);
    }
    // 5. Utility imports
    else if (isFromUtils) {
      groups.utils.push(imp);
    }
    // 6. ALL OTHER general local imports (the final fallback for src/ paths)
    else if (isFromSrc) {
      groups.local.push(imp);
    }
    // ====================================================================================
    // END RE-ORDERED SOURCE-BASED IMPORT CHECKS
    // ====================================================================================

    // If nothing else matches (neither external nor any specific src/ group)
    else {
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
    ...formatGroup('Redux', groups.redux), // Core redux imports (e.g., from 'redux', 'react-redux' directly)
    ...formatGroup('Types', groups.types),
    ...formatGroup('Redux Store', groups.reduxStore),
    ...formatGroup('API', groups.api),
    ...formatGroup('Hooks', groups.hooks),
    ...formatGroup('Utils', groups.utils),
    ...formatGroup('Local', groups.local),
    ...formatGroup('Unknown', groups.unknown)
  ].join('\n');
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    'importGrouper.organizeImports',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const text = document.getText();

      // Regex to capture full import lines, including potential trailing whitespace/semicolons
      const importRegex = /^import .* from .*;?\s*$/gm;
      const importMatches = [...text.matchAll(importRegex)].map((m) =>
        m[0].trim()
      );

      if (!importMatches.length) return;

      // The groupAndSortImports function is synchronous
      const groupedImports = groupAndSortImports(importMatches);

      // Determine the range of the original import block to replace
      const firstImportMatchIndex = text.indexOf(importMatches[0]);
      const lastImportMatchIndex = text.lastIndexOf(
        importMatches[importMatches.length - 1]
      );

      const startPosition = document.positionAt(firstImportMatchIndex);
      const endPosition = document.positionAt(
        lastImportMatchIndex + importMatches[importMatches.length - 1].length
      );

      // Create a range that spans from the start of the first import's line to the end of the last import's line
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
