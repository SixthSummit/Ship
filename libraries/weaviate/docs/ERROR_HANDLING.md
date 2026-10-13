# Error Handling in Weaviate Library

## Overview

The Weaviate library now uses a consistent, structured approach to error handling through the `WeaviateError` class. This provides better error messages, programmatic error handling, and improved debugging.

## WeaviateError Class

The `WeaviateError` class extends the native `Error` class and provides:
- **Error Codes**: Enum-based error codes for programmatic handling
- **Details**: Additional context about the error (including original error)
- **Stack Traces**: Proper stack trace preservation
- **Helper Methods**: Utilities for error type checking and conversion

### Usage

```typescript
import { WeaviateError, WeaviateErrorCode } from '@weaviate/lib';

try {
  await weaviate.createObject({ class: 'Person', properties: { name: 'John' } });
} catch (error) {
  if (error instanceof WeaviateError) {
    console.log('Error Code:', error.code);
    console.log('Message:', error.message);
    console.log('Details:', error.details);
    
    // Check specific error type
    if (error.is(WeaviateErrorCode.OBJECT_CREATION_ERROR)) {
      // Handle object creation errors
    }
  }
}
```

## Error Codes

### Schema Errors
- `SCHEMA_VALIDATION_ERROR` - Schema failed validation
- `SCHEMA_CREATION_ERROR` - Failed to create schema
- `SCHEMA_NOT_FOUND` - Schema doesn't exist

### Search Errors
- `SEARCH_ERROR` - General search operation failed
- `INVALID_SEARCH_METHOD` - Invalid search method specified

### CRUD Errors
- `OBJECT_CREATION_ERROR` - Failed to create object
- `OBJECT_UPDATE_ERROR` - Failed to update object
- `OBJECT_DELETE_ERROR` - Failed to delete object
- `OBJECT_RETRIEVAL_ERROR` - Failed to retrieve object
- `BATCH_OPERATION_ERROR` - Batch operation failed

### Tenant Errors
- `TENANT_CREATION_ERROR` - Failed to create tenant
- `TENANT_UPDATE_ERROR` - Failed to update tenant
- `TENANT_DELETE_ERROR` - Failed to delete tenant
- `TENANT_RETRIEVAL_ERROR` - Failed to retrieve tenant
- `TENANT_VALIDATION_ERROR` - Tenant name validation failed
- `TENANT_NOT_FOUND` - Tenant doesn't exist

### General Errors
- `UNKNOWN_ERROR` - Unclassified error
- `VALIDATION_ERROR` - General validation error
- `CONNECTION_ERROR` - Connection to Weaviate failed

## Error Handling Patterns

### Standard Pattern

All Weaviate methods follow this consistent pattern:

```typescript
async someMethod(params): Promise<Result> {
  try {
    // Operation
    const result = await this.client.doSomething();
    return result;
  } catch (error) {
    Logger.log("Context about the operation:", error);
    throw WeaviateError.from(
      error,
      WeaviateErrorCode.APPROPRIATE_ERROR_CODE,
      "Human-readable error message with context"
    );
  }
}
```

### Benefits

1. **Consistent Logging**: All errors are logged with context before being thrown
2. **Structured Errors**: Errors include error codes for programmatic handling
3. **Context Preservation**: Original errors are preserved in the `details` field
4. **Type Safety**: TypeScript IntelliSense provides autocomplete for error codes

### Error Wrapping

The `WeaviateError.from()` helper safely wraps any error type:

```typescript
// Handles WeaviateError (pass-through)
// Handles Error (wraps with message)
// Handles unknown types (converts to string)
throw WeaviateError.from(
  error,
  WeaviateErrorCode.SEARCH_ERROR,
  `Failed to search ${schemaName}`
);
```

## Examples

### Basic Error Handling

```typescript
try {
  const results = await weaviate.search('Person', {
    method: 'hybrid',
    options: { hybrid: { query: 'engineer' }, limit: 10 }
  });
} catch (error) {
  if (error instanceof WeaviateError) {
    console.error(`Error ${error.code}: ${error.message}`);
    
    // Log details for debugging
    console.error('Details:', error.details);
  } else {
    // Unexpected error type
    console.error('Unexpected error:', error);
  }
}
```

### Type-Specific Error Handling

```typescript
try {
  await weaviate.createObject({
    class: 'Person',
    properties: { name: 'John Doe' }
  });
} catch (error) {
  if (error instanceof WeaviateError) {
    switch (error.code) {
      case WeaviateErrorCode.OBJECT_CREATION_ERROR:
        // Handle creation errors (maybe retry)
        break;
      case WeaviateErrorCode.VALIDATION_ERROR:
        // Handle validation errors (fix input)
        break;
      default:
        // Handle other errors
        break;
    }
  }
}
```

### Error Serialization

```typescript
try {
  // ... operation
} catch (error) {
  if (error instanceof WeaviateError) {
    // Send to logging service
    logger.error(JSON.stringify(error.toJSON()));
    
    // Or send to client
    res.status(500).json(error.toJSON());
  }
}
```

## Migration from Old Error Handling

### Before (Inconsistent)

```typescript
// Pattern 1: Log and throw
catch (error) {
  Logger.log("Error:", error);
  throw error;
}

// Pattern 2: Log and return error object
catch (error) {
  Logger.log("Error:", error);
  return { success: false, error: error.message };
}

// Pattern 3: Just throw
catch (error) {
  throw error;
}
```

### After (Consistent)

```typescript
// Consistent pattern everywhere
catch (error) {
  Logger.log("Descriptive context:", error);
  throw WeaviateError.from(
    error,
    WeaviateErrorCode.APPROPRIATE_CODE,
    "Clear message with context"
  );
}
```

## Best Practices

1. **Always Use Error Codes**: Choose the most specific error code available
2. **Provide Context**: Include relevant parameters in error messages
3. **Log Before Throwing**: Always log with context before throwing
4. **Preserve Original Error**: The original error is automatically preserved in `details`
5. **Type Check**: Use `instanceof WeaviateError` to check error type
6. **Use Helper Methods**: Use `error.is(code)` for clean type checking

## Testing Errors

```typescript
import { describe, it, expect } from 'vitest';
import { WeaviateError, WeaviateErrorCode } from './lib/weaviate';

describe('Error Handling', () => {
  it('should throw WeaviateError with correct code', async () => {
    await expect(
      weaviate.search('NonExistent', { method: 'vector', options: {} })
    ).rejects.toThrow(WeaviateError);
    
    await expect(
      weaviate.search('NonExistent', { method: 'vector', options: {} })
    ).rejects.toMatchObject({
      code: WeaviateErrorCode.SEARCH_ERROR
    });
  });
});
```

## Error Handling Guidelines

### For Library Developers

1. **Never swallow errors**: Always either handle or rethrow with context
2. **Use appropriate codes**: Select the most specific error code
3. **Add context**: Include parameter values in error messages
4. **Test error paths**: Write tests for error scenarios
5. **Document errors**: Document what errors methods can throw

### For Library Users

1. **Catch WeaviateError**: Use type guards to handle errors properly
2. **Check error codes**: Use error codes for conditional logic
3. **Log details**: The `details` field contains the original error
4. **Don't rely on message**: Error messages may change; use codes
5. **Handle gracefully**: Provide meaningful feedback to end users

## Conclusion

The new error handling system provides:
- ✅ Consistent error handling patterns
- ✅ Better debugging with error codes
- ✅ Preserved stack traces and context
- ✅ Type-safe error checking
- ✅ Improved developer experience

All methods in the Weaviate library now follow these patterns, making it easier to build robust applications.

