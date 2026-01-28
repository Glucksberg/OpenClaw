#!/bin/bash

# Enhanced script for checking false positives with robust error handling
# Usage: ./check-false-positive.sh "error message" [process_name]

set -euo pipefail  # Strict error handling

ERROR_MSG="$1"
PROCESS_NAME="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/false-positive-manager.cjs"

# Validation
if [ -z "$ERROR_MSG" ]; then
    echo "ERROR: Missing error message"
    echo "Usage: $0 \"error message\" [process_name]"
    exit 1
fi

# Check if script exists
if [ ! -f "$SCRIPT_PATH" ]; then
    echo "ERROR: False positive manager script not found at $SCRIPT_PATH"
    exit 1
fi

# Check if Node.js is available
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js not found in PATH"
    exit 1
fi

# Run the check with proper error handling
if ! RESULT=$(node "$SCRIPT_PATH" check "$ERROR_MSG" "$PROCESS_NAME" 2>/dev/null); then
    echo "SCRIPT_ERROR: Failed to execute false positive check"
    exit 1
fi

# Validate result format
if [ -z "$RESULT" ]; then
    echo "SCRIPT_ERROR: Empty result from false positive manager"
    exit 1
fi

# Check if it's a known false positive
if [ "$RESULT" = "null" ]; then
    echo "NEW_ISSUE"
else
    # Validate JSON and extract fields safely
    if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
        echo "SCRIPT_ERROR: Invalid JSON response"
        exit 1
    fi
    
    FP_ID=$(echo "$RESULT" | jq -r '.id // "unknown"' 2>/dev/null)
    COUNT=$(echo "$RESULT" | jq -r '.fp.count // 0' 2>/dev/null)
    AUTO_RESOLVE=$(echo "$RESULT" | jq -r '.fp.auto_resolve // false' 2>/dev/null)
    SEVERITY=$(echo "$RESULT" | jq -r '.fp.severity // "unknown"' 2>/dev/null)
    
    # Validate extracted data
    if [ "$FP_ID" = "unknown" ] || [ "$COUNT" = "0" ]; then
        echo "SCRIPT_ERROR: Invalid false positive data"
        exit 1
    fi
    
    echo "FALSE_POSITIVE:$FP_ID:$COUNT:$AUTO_RESOLVE:$SEVERITY"
fi