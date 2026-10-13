#!/bin/bash

# ShipAngular CI Check Script
# This script runs all the same checks as the GitHub Actions CI workflow

set -e  # Exit on any error

echo "🚀 Running ShipAngular CI checks..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    print_error "package.json not found. Please run this script from the project root."
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    print_warning "node_modules not found. Installing dependencies..."
    pnpm install --frozen-lockfile
fi

# Run type checking
echo "🔍 Running TypeScript type check..."
if pnpm type-check; then
    print_status "TypeScript type check passed"
else
    print_error "TypeScript type check failed"
    exit 1
fi

# Run linting
echo "🧹 Running ESLint..."
if pnpm lint; then
    print_status "ESLint passed"
else
    print_error "ESLint failed"
    print_warning "Run 'pnpm lint:fix' to auto-fix many issues"
    exit 1
fi

# Check code formatting
echo "🎨 Checking code formatting..."
if pnpm format:check; then
    print_status "Code formatting check passed"
else
    print_error "Code formatting check failed"
    print_warning "Run 'pnpm format' to auto-format code"
    exit 1
fi

# Run tests
echo "🧪 Running unit tests..."
if pnpm test:coverage; then
    print_status "Unit tests passed"
else
    print_error "Unit tests failed"
    exit 1
fi

# Build the application
echo "🏗️  Building application..."
if pnpm build; then
    print_status "Build successful"
else
    print_error "Build failed"
    exit 1
fi

# Security audit
echo "🔒 Running security audit..."
if pnpm audit --audit-level=moderate; then
    print_status "Security audit passed"
else
    print_warning "Security audit found issues. Review the output above."
fi

echo ""
print_status "All CI checks passed! 🎉"
echo ""
echo "You can now commit your changes with confidence."
echo "The same checks will run automatically in GitHub Actions."
