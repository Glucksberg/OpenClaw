#!/bin/bash
# Claude Code & claude-mem Process Monitor
# Runs 24/7, logs process stats every minute, alerts on anomalies

LOG_DIR="/home/dev/clawd/monitors/logs"
LOG_FILE="$LOG_DIR/claude-monitor.log"
STATS_FILE="$LOG_DIR/claude-stats.jsonl"
ALERT_LOG="$LOG_DIR/claude-alerts.log"

# Thresholds
MAX_CLAUDE_INSTANCES=10
MAX_MEM_PER_INSTANCE_MB=2000
MAX_TOTAL_MEM_MB=16000
MAX_ORPHAN_MCP=3
ZOMBIE_TIMEOUT_HOURS=6

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $1" | tee -a "$LOG_FILE"
}

alert() {
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ⚠️  $1" | tee -a "$ALERT_LOG" "$LOG_FILE"
}

collect_stats() {
    local timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    
    # Get all claude processes with details
    local claude_procs=$(ps aux --no-headers | grep -E "[c]laude" | grep -v "claude-monitor" || true)
    local claude_count=$(echo "$claude_procs" | grep -c "claude" 2>/dev/null || echo 0)
    [ -z "$claude_procs" ] && claude_count=0
    
    # Get all claude-mem related processes
    local mcp_procs=$(ps aux --no-headers | grep -E "claude-mem.*mcp-server" | grep -v grep || true)
    local mcp_count=$(echo "$mcp_procs" | grep -c "mcp-server" 2>/dev/null || echo 0)
    [ -z "$mcp_procs" ] && mcp_count=0
    
    # Worker service
    local worker_procs=$(ps aux --no-headers | grep -E "claude-mem.*worker-service" | grep -v grep || true)
    local worker_count=$(echo "$worker_procs" | grep -c "worker-service" 2>/dev/null || echo 0)
    [ -z "$worker_procs" ] && worker_count=0
    
    # Chroma MCP
    local chroma_procs=$(ps aux --no-headers | grep -E "chroma-mcp" | grep -v grep || true)
    local chroma_count=$(echo "$chroma_procs" | grep -c "chroma" 2>/dev/null || echo 0)
    [ -z "$chroma_procs" ] && chroma_count=0
    
    # Calculate memory usage (RSS in MB)
    local claude_mem_kb=0
    local mcp_mem_kb=0
    
    if [ -n "$claude_procs" ] && [ "$claude_count" -gt 0 ]; then
        claude_mem_kb=$(echo "$claude_procs" | awk '{sum+=$6} END {print sum+0}')
    fi
    
    if [ -n "$mcp_procs" ] && [ "$mcp_count" -gt 0 ]; then
        mcp_mem_kb=$(echo "$mcp_procs" | awk '{sum+=$6} END {print sum+0}')
    fi
    
    local claude_mem_mb=$((claude_mem_kb / 1024))
    local mcp_mem_mb=$((mcp_mem_kb / 1024))
    local total_mem_mb=$((claude_mem_mb + mcp_mem_mb))
    
    # Get system memory
    local sys_mem_available=$(grep MemAvailable /proc/meminfo | awk '{print int($2/1024)}')
    local sys_mem_total=$(grep MemTotal /proc/meminfo | awk '{print int($2/1024)}')
    local sys_swap_used=$(free -m | grep Swap | awk '{print $3}')
    
    # Check for zombie/stopped processes
    local stopped_claude=$(echo "$claude_procs" | grep -E "T[l+]?" | wc -l || echo 0)
    local zombie_procs=$(ps aux | grep -E "[c]laude" | grep "Z" | wc -l || echo 0)
    
    # Check for orphaned mcp-servers (no parent claude process)
    local orphan_mcp=0
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local mcp_pid=$(echo "$line" | awk '{print $2}')
        local mcp_ppid=$(ps -o ppid= -p "$mcp_pid" 2>/dev/null | tr -d ' ')
        if [ -n "$mcp_ppid" ]; then
            local parent_cmd=$(ps -o comm= -p "$mcp_ppid" 2>/dev/null)
            if [[ ! "$parent_cmd" =~ claude ]]; then
                ((orphan_mcp++))
            fi
        fi
    done <<< "$mcp_procs"
    
    # Process details for JSON
    local proc_details=""
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local pid=$(echo "$line" | awk '{print $2}')
        local cpu=$(echo "$line" | awk '{print $3}')
        local mem_kb=$(echo "$line" | awk '{print $6}')
        local mem_mb=$((mem_kb / 1024))
        local state=$(echo "$line" | awk '{print $8}')
        local started=$(echo "$line" | awk '{print $9}')
        local time=$(echo "$line" | awk '{print $10}')
        local cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf $i" "; print ""}' | head -c 100)
        
        # Get child mcp-server if any
        local child_mcp=$(pgrep -P "$pid" -a 2>/dev/null | grep "mcp-server" | awk '{print $1}' | head -1)
        
        [ -n "$proc_details" ] && proc_details+=","
        proc_details+="{\"pid\":$pid,\"cpu\":$cpu,\"mem_mb\":$mem_mb,\"state\":\"$state\",\"started\":\"$started\",\"time\":\"$time\",\"mcp_child\":\"${child_mcp:-null}\"}"
    done <<< "$(echo "$claude_procs" | grep -v "claude-monitor")"
    
    # Build JSON stats
    local json=$(cat <<EOF
{"ts":"$timestamp","claude":{"count":$claude_count,"mem_mb":$claude_mem_mb,"stopped":$stopped_claude,"zombies":$zombie_procs},"mcp":{"count":$mcp_count,"mem_mb":$mcp_mem_mb,"orphans":$orphan_mcp},"worker":$worker_count,"chroma":$chroma_count,"total_mem_mb":$total_mem_mb,"system":{"available_mb":$sys_mem_available,"total_mb":$sys_mem_total,"swap_used_mb":$sys_swap_used},"procs":[$proc_details]}
EOF
)
    
    echo "$json" >> "$STATS_FILE"
    
    # Check alerts
    if [ "$claude_count" -gt "$MAX_CLAUDE_INSTANCES" ]; then
        alert "Too many Claude instances: $claude_count (max: $MAX_CLAUDE_INSTANCES)"
    fi
    
    if [ "$total_mem_mb" -gt "$MAX_TOTAL_MEM_MB" ]; then
        alert "High memory usage: ${total_mem_mb}MB (threshold: ${MAX_TOTAL_MEM_MB}MB)"
    fi
    
    if [ "$orphan_mcp" -gt "$MAX_ORPHAN_MCP" ]; then
        alert "Orphaned MCP servers detected: $orphan_mcp"
    fi
    
    if [ "$zombie_procs" -gt 0 ]; then
        alert "Zombie processes detected: $zombie_procs"
    fi
    
    if [ "$stopped_claude" -gt 2 ]; then
        alert "Multiple stopped Claude processes: $stopped_claude"
    fi
    
    # Log summary
    log "Claude: $claude_count (${claude_mem_mb}MB, $stopped_claude stopped) | MCP: $mcp_count (${mcp_mem_mb}MB, $orphan_mcp orphans) | Worker: $worker_count | Chroma: $chroma_count | Total: ${total_mem_mb}MB | Sys avail: ${sys_mem_available}MB"
}

cleanup_orphans() {
    # Only run cleanup if called with --cleanup flag
    [ "$1" != "--cleanup" ] && return
    
    log "Running orphan cleanup..."
    local cleaned=0
    
    # Find mcp-server processes without claude parent
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local mcp_pid=$(echo "$line" | awk '{print $2}')
        local mcp_ppid=$(ps -o ppid= -p "$mcp_pid" 2>/dev/null | tr -d ' ')
        if [ -n "$mcp_ppid" ]; then
            local parent_cmd=$(ps -o comm= -p "$mcp_ppid" 2>/dev/null)
            if [[ ! "$parent_cmd" =~ claude ]]; then
                log "Killing orphaned mcp-server PID $mcp_pid (parent: $mcp_ppid = $parent_cmd)"
                kill "$mcp_pid" 2>/dev/null && ((cleaned++))
            fi
        fi
    done <<< "$(ps aux --no-headers | grep -E "claude-mem.*mcp-server" | grep -v grep)"
    
    log "Cleaned up $cleaned orphaned processes"
}

show_status() {
    echo "=== Claude Code Process Monitor Status ==="
    echo ""
    
    # Current stats
    echo "📊 Current State:"
    ps aux --no-headers | grep -E "[c]laude" | grep -v "claude-monitor" | awk '
        BEGIN { count=0; mem=0 }
        { count++; mem+=$6/1024; printf "  PID %s: %.1f%% CPU, %dMB RAM, state=%s, %s\n", $2, $3, $6/1024, $8, $11 }
        END { printf "\n  Total: %d processes, %dMB RAM\n", count, mem }
    '
    
    echo ""
    echo "🔌 MCP Servers:"
    ps aux --no-headers | grep -E "claude-mem.*mcp-server" | grep -v grep | awk '
        { printf "  PID %s: %dMB RAM\n", $2, $6/1024 }
    ' || echo "  None running"
    
    echo ""
    echo "📈 Recent Stats (last 10):"
    if [ -f "$STATS_FILE" ]; then
        tail -10 "$STATS_FILE" | jq -r '"  \(.ts): \(.claude.count) claude (\(.claude.mem_mb)MB), \(.mcp.count) mcp, total \(.total_mem_mb)MB"' 2>/dev/null || tail -5 "$STATS_FILE"
    else
        echo "  No stats yet"
    fi
    
    echo ""
    echo "⚠️  Recent Alerts (last 5):"
    if [ -f "$ALERT_LOG" ]; then
        tail -5 "$ALERT_LOG" || echo "  No alerts"
    else
        echo "  No alerts"
    fi
}

# Main
case "${1:-}" in
    --status)
        show_status
        ;;
    --cleanup)
        cleanup_orphans --cleanup
        ;;
    --once)
        collect_stats
        ;;
    --daemon)
        log "Starting Claude Monitor daemon (interval: 60s)"
        while true; do
            collect_stats
            sleep 60
        done
        ;;
    *)
        echo "Usage: $0 [--status|--cleanup|--once|--daemon]"
        echo ""
        echo "  --status   Show current process status and recent stats"
        echo "  --cleanup  Kill orphaned mcp-server processes"
        echo "  --once     Collect stats once and exit"
        echo "  --daemon   Run continuously (every 60s)"
        ;;
esac
