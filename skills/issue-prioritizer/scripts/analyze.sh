#!/bin/bash
# Wrapper script for issue-prioritizer CLI
# Usage: ./analyze.sh <owner/repo> [options]

TOOL_DIR="/home/dev/agents/issue-prioritizer"

if [ -z "$1" ]; then
    echo "Usage: $0 <owner/repo> [options]"
    echo ""
    echo "Commands:"
    echo "  analyze <repo>     Full analysis"
    echo "  quick-wins <repo>  Quick wins only"
    echo "  for-me <repo>      By skill level"
    echo "  next <repo>        Single best issue"
    echo ""
    echo "Example: $0 analyze openclaw/openclaw --limit 50"
    exit 1
fi

cd "$TOOL_DIR" && bun src/cli.ts "$@"
