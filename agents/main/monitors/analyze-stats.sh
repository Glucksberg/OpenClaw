#!/bin/bash
# Analyze Claude monitor statistics

STATS_FILE="/home/dev/clawd/monitors/logs/claude-stats.jsonl"

if [ ! -f "$STATS_FILE" ]; then
    echo "No stats file found. Run the monitor first."
    exit 1
fi

echo "📊 Claude Process Statistics Analysis"
echo "======================================"
echo ""

# Total records
total=$(wc -l < "$STATS_FILE")
echo "Total samples: $total"

if [ "$total" -lt 2 ]; then
    echo "Not enough data for analysis yet."
    exit 0
fi

# Time range
first_ts=$(head -1 "$STATS_FILE" | jq -r '.ts')
last_ts=$(tail -1 "$STATS_FILE" | jq -r '.ts')
echo "Time range: $first_ts to $last_ts"
echo ""

# Average stats
echo "📈 Averages:"
jq -s '
  {
    avg_claude_count: ([.[].claude.count] | add / length | . * 10 | floor / 10),
    avg_claude_mem_mb: ([.[].claude.mem_mb] | add / length | floor),
    avg_mcp_count: ([.[].mcp.count] | add / length | . * 10 | floor / 10),
    avg_total_mem_mb: ([.[].total_mem_mb] | add / length | floor),
    avg_stopped: ([.[].claude.stopped] | add / length | . * 10 | floor / 10),
    avg_orphans: ([.[].mcp.orphans] | add / length | . * 10 | floor / 10)
  }
' "$STATS_FILE" | jq -r '
  "  Claude instances: \(.avg_claude_count) avg",
  "  Claude memory: \(.avg_claude_mem_mb)MB avg",
  "  MCP servers: \(.avg_mcp_count) avg", 
  "  Total memory: \(.avg_total_mem_mb)MB avg",
  "  Stopped processes: \(.avg_stopped) avg",
  "  Orphaned MCP: \(.avg_orphans) avg"
'

echo ""
echo "📊 Maximums:"
jq -s '
  {
    max_claude_count: ([.[].claude.count] | max),
    max_claude_mem_mb: ([.[].claude.mem_mb] | max),
    max_total_mem_mb: ([.[].total_mem_mb] | max),
    max_stopped: ([.[].claude.stopped] | max),
    max_orphans: ([.[].mcp.orphans] | max)
  }
' "$STATS_FILE" | jq -r '
  "  Max Claude instances: \(.max_claude_count)",
  "  Max Claude memory: \(.max_claude_mem_mb)MB",
  "  Max total memory: \(.max_total_mem_mb)MB",
  "  Max stopped: \(.max_stopped)",
  "  Max orphans: \(.max_orphans)"
'

echo ""
echo "⚠️  Alerts count:"
if [ -f "/home/dev/clawd/monitors/logs/claude-alerts.log" ]; then
    total_alerts=$(wc -l < "/home/dev/clawd/monitors/logs/claude-alerts.log")
    echo "  Total alerts: $total_alerts"
    echo ""
    echo "  By type:"
    grep -o "⚠️.*:" "/home/dev/clawd/monitors/logs/claude-alerts.log" | sort | uniq -c | sort -rn
else
    echo "  No alerts recorded"
fi

echo ""
echo "🕐 Memory trend (last 10 samples):"
tail -10 "$STATS_FILE" | jq -r '"\(.ts | split("T")[1] | split("Z")[0]): \(.claude.count) claude (\(.claude.mem_mb)MB) | \(.mcp.count) mcp | total \(.total_mem_mb)MB"'

echo ""
echo "💡 Tip: Run 'claude-monitor.sh --cleanup' to kill orphaned processes"
