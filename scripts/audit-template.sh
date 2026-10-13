#!/bin/bash
# =============================================================================
# Template Audit Script
# =============================================================================
#
# PURPOSE:
#   Audits the default project template for security vulnerabilities.
#   The template excludes @sixthsummit/ship-api so it can be audited
#   without GitHub Package Registry authentication.
#
# USAGE:
#   ./scripts/audit-template.sh [--fix]
#
# OPTIONS:
#   --fix    Attempt to automatically fix vulnerabilities
#
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TEMPLATE_DIR="packages/core/templates/default"

echo -e "${CYAN}📦 Auditing template dependencies...${NC}"
echo ""

# Navigate to template directory
cd "$TEMPLATE_DIR"

# Generate lockfile if it doesn't exist
if [ ! -f "package-lock.json" ]; then
    echo -e "${YELLOW}Generating package-lock.json...${NC}"
    npm i --package-lock-only
fi

# Run audit
if [ "$1" == "--fix" ]; then
    echo -e "${YELLOW}Running npm audit fix...${NC}"
    npm audit fix || true
    echo ""
    echo -e "${GREEN}✓ Audit fix complete${NC}"
    echo -e "${YELLOW}Note: Review changes and commit if appropriate${NC}"
else
    echo -e "${YELLOW}Running npm audit...${NC}"
    npm audit || true
    echo ""
    echo -e "${CYAN}To fix vulnerabilities, run:${NC}"
    echo -e "  ${YELLOW}./scripts/audit-template.sh --fix${NC}"
fi
