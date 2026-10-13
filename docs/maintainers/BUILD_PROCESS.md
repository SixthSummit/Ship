# Build Process Documentation

## Overview

The ShipAPI Framework uses a modern build process that compiles TypeScript source code to optimized JavaScript with TypeScript declaration files for the best developer experience and performance.

## Build Configuration

### TypeScript Configuration

The library uses a separate TypeScript configuration (`tsconfig.lib.json`) specifically for building the distributable library:

- **Target**: ES2022 for modern JavaScript features
- **Module System**: NodeNext for optimal Node.js compatibility
- **Output**: Compiled JavaScript (.js) with TypeScript declarations (.d.ts)
- **Source Maps**: Generated for debugging support
- **Declaration Maps**: Generated for enhanced IDE support

### Build Process

1. **Clean**: Remove existing `lib/` directory
2. **Compile**: TypeScript compilation with declarations
3. **Copy**: Binary files to `lib/bin/`
4. **Package**: Create `lib/package.json` for module resolution

## Output Structure

```
lib/
├── index.js                    # Main entry point (compiled)
├── index.d.ts                  # TypeScript declarations
├── index.d.ts.map              # Declaration source maps
├── index.js.map                # JavaScript source maps
├── package.json                # Module configuration
├── app/                         # App layer (compiled)
│   ├── entity/
│   ├── services/
│   ├── utils/
│   └── ...
├── http/                        # HTTP layer (compiled)
│   ├── middleware/
│   ├── errors/
│   └── ...
└── bin/                         # CLI tools
    └── ship-api.js
```

## Benefits

### For Library Consumers

- **Performance**: Pre-compiled JavaScript loads faster than TypeScript
- **Compatibility**: Works with any JavaScript runtime
- **Type Safety**: Full TypeScript declarations for IDE support
- **Tree Shaking**: Optimized for bundlers to eliminate unused code
- **Source Maps**: Enhanced debugging experience

### For Library Maintainers

- **Optimized Builds**: TypeScript compilation optimizations
- **Declaration Generation**: Automatic .d.ts file creation
- **Source Maps**: Full debugging support
- **Module Resolution**: Proper ES module support

## Package.json Configuration

The main `package.json` is configured for optimal consumption:

```json
{
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": {
      "import": "./lib/index.js",
      "types": "./lib/index.d.ts"
    },
    "./*": {
      "import": "./lib/*.js",
      "types": "./lib/*.d.ts"
    }
  }
}
```

## Usage Examples

### Importing the Library

```typescript
// Barrel — semver-stable public surface
import {
  createApp,
  registerErrorHandlers,
  httpLogger,
  requireAuth,
  requirePermission,
  validate,
  DrizzleEntityService,
  AppError,
  NotFoundError,
} from "@sixthsummit/ship-api";

// Subpath — typed-client bundle (no runtime deps)
import { hc } from "@sixthsummit/ship-api/client";

// Subpath — observability (when you need direct logger / OTel access)
import { logger } from "@sixthsummit/ship-api/observability/logger";
```

### Development Workflow

1. **Development**: Work with TypeScript source in `src/lib/`
2. **Build**: Run `npm run build` to compile library
3. **Test**: Verify compiled output works correctly
4. **Publish**: Ship compiled JavaScript with declarations

## Build Commands

```bash
# Build the entire project (app + library)
npm run build

# Build only the library
npx tsc --project tsconfig.lib.json

# Type check without compilation
npm run type-check
```

## Best Practices

1. **Always build before publishing** to ensure consumers get compiled code
2. **Test the compiled output** to verify it works correctly
3. **Keep source maps** for debugging support
4. **Use declaration maps** for enhanced IDE experience
5. **Maintain separate configs** for app vs library compilation

## Troubleshooting

### Common Issues

1. **TypeScript Errors**: Check `tsconfig.lib.json` configuration
2. **Import Errors**: Verify `package.json` exports configuration
3. **Missing Declarations**: Ensure `declaration: true` in TypeScript config
4. **Module Resolution**: Check `lib/package.json` configuration

### Debug Commands

```bash
# Check TypeScript compilation
npx tsc --project tsconfig.lib.json --noEmit

# Verify output structure
ls -la lib/

# Test library import
node -e "import('./lib/index.js').then(console.log)"
```
