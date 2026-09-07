# Import Formatter

## Download (Prebuilt VSIX)

You can download the packaged extension from GitHub Releases:

- Release page: https://github.com/billiyo/billiyo-spa-import-formatter/releases/tag/v0.0.2

From that page, download the `import-formatter-0.0.2.vsix` asset and install it in VS Code using **Extensions: Install from VSIX...**.

## Build It Yourself

If you prefer, you can build the extension package locally.

This VS Code extension automates the organization of import statements in TypeScript and JavaScript files. It offers several features to keep your imports clean, consistent, and readable.

## Features

### 1. Relative to Absolute Import Conversion

This feature automatically converts relative import paths (e.g., `../utils/myUtils`) to absolute paths based on your workspace's `src` directory (e.g., `src/utils/myUtils`). This is particularly useful in larger projects where consistent absolute paths improve readability and refactoring.

**Example:**

**Before:**

```typescript
import { myUtilityFunction } from '../utils/myUtils';
import { AnotherComponent } from '../../components/AnotherComponent';
```

**After:**

```typescript
import { myUtilityFunction } from 'src/utils/myUtils';
import { AnotherComponent } from 'src/components/AnotherComponent';
```

### 2. Import Grouping and Sorting

The extension intelligently groups imports into predefined categories and sorts them alphabetically within each group. This provides a clear and standardized structure for your import blocks. The predefined groups include:

- Next.js imports
- React imports
- MUI (Material-UI) imports
- Third-party imports
- Type imports
- Redux store imports
- API client imports
- Custom hooks imports
- Local project imports (within `src/`)
- Utility imports
- Unknown imports (categorized if they don't fit other groups)

Each group is preceded by a comment for easy navigation.

**Example:**

**Before:**

```typescript
import { Button } from '@mui/material';
import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { fetchUsers } from '../../store/slices/userSlice';
import { AppLayout } from '../layout/AppLayout';
import { User } from '../types';
import { useRouter } from 'next/router';
import { SomeIcon } from '@mui/icons-material';
import { useAuth } from '../hooks/useAuth';
import { formatCurrency } from '../utils/formatters';
import { getUserProfile } from '../api-clients/userApiClient';
```

**After:**

```typescript
// ** Next Imports
import { useRouter } from 'next/router';

// ** React Imports
import { useState } from 'react';

// ** MUI Imports
import Button from '@mui/material/Button';
import SomeIcon from '@mui/icons-material/SomeIcon';

// ** Third Party Imports
import { useDispatch } from 'react-redux';

// ** Types Imports
import { User } from 'src/types';

// ** Redux Store Imports
import { fetchUsers } from 'src/store/slices/userSlice';

// ** API Imports
import { getUserProfile } from 'src/api-clients/userApiClient';

// ** Hooks Imports
import { useAuth } from 'src/hooks/useAuth';

// ** Local Imports
import { AppLayout } from 'src/layout/AppLayout';

// ** Utils Imports
import { formatCurrency } from 'src/utils/formatters';
```

### 3. Smart Type Import Separation

The extension can differentiate between regular and type imports. If a named import is identified as a type (e.g., an interface, type alias, or enum), it will be moved to a separate `import type` statement within the 'Types' group, enhancing clarity and adhering to TypeScript best practices.

**Example:**

**Before:**

```typescript
import { MyComponent, MyInterface, MyType } from 'src/common/types';
```

**After:**

```typescript
// ** Local Imports
import { MyComponent } from 'src/common/types';

// ** Types Imports
import { MyInterface, MyType } from 'src/common/types';
```

### 4. MUI Component Direct Imports

For `@mui/material` and `@mui/icons-material` imports, the extension automatically transforms grouped named imports into direct imports for each component. This can help with tree-shaking and potentially reduce bundle size.

**Example:**

**Before:**

```typescript
import { Button, TextField } from '@mui/material';
import { AddIcon, DeleteIcon } from '@mui/icons-material';
```

**After:**

```typescript
// ** MUI Imports
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import AddIcon from '@mui/icons-material/AddIcon';
import DeleteIcon from '@mui/icons-material/DeleteIcon';
```

### 5. Multi-line Import Formatting

For imports with multiple named items, the extension formats them into multi-line statements when the single-line version exceeds a `printWidth` of 120 characters, improving readability. Single-item imports remain on a single line.

**Example:**

**Before:**

```typescript
import {
  VeryLongComponentNameOne,
  AnotherVeryLongComponentNameTwo,
  YetAnotherLongComponentNameThree,
  AndOneMoreLongComponentNameFour,
} from 'src/components/LongComponents';
```

**After:**

```typescript
import {
  VeryLongComponentNameOne,
  AnotherVeryLongComponentNameTwo,
  YetAnotherLongComponentNameThree,
  AndOneMoreLongComponentNameFour,
} from 'src/components/LongComponents';
```

## Build and Use Locally

1. Run the following command in your terminal:
   ```bash
   npm run package
   ```
   (If asked for LICENSE file, you can type "y" to proceed)
2. This will create a `.vsix` file in the root directory of the project.

3. **Install the Extension:** Install the `.vsix` file manually in VS Code.
4. **Run the Command:** Open a TypeScript or JavaScript file.
   - Use the shortcut `Ctrl+Shift+A`.

The extension will automatically reformat your import statements according to the rules described above.
