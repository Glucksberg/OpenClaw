#!/bin/bash
# Claude Code Process Lifecycle Tracker
# Monitors process birth/death events in real-time
# Start this when you begin working, stop when done

set -u  # Only fail on undefined variables, not on command errors

LOG_DIR="/home/dev/clawd/monitors/logs"
SESSION_ID=$(date +%Y%m%d_%H%M%S)
EVENT_LOG="$LOG_DIR/session_${SESSION_ID}_events.jsonl"
TIMELINE_LOG="$LOG_DIR/session_${SESSION_ID}_timeline.log"
POLL_INTERVAL=2  # seconds between checks

mkdir -p "$LOG_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# State tracking
declare -A PREV_PROCS=()       # PID -> "type:mem:state:start_time"
declare -A PROC_BIRTH=()       # PID -> timestamp when first seen
declare -A MCP_PARENT=()       # MCP PID -> Claude parent PID
PREV_SNAPSHOT=""
EVENT_COUNT=0
ANOMALY_COUNT=0

log_event() {
    local event_type="$1"
    local pid="${2:-}"
    local details="${3:-}"
    local ts=$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')
    local mem_total=$(get_total_mem)
    local proc_counts=$(get_proc_counts)
    
    ((EVENT_COUNT++))
    
    local json=$(jq -n \
        --arg ts "$ts" \
        --arg event "$event_type" \
        --arg pid "$pid" \
        --arg details "$details" \
        --arg mem "$mem_total" \
        --arg counts "$proc_counts" \
        --arg event_num "$EVENT_COUNT" \
        '{ts: $ts, event_num: ($event_num|tonumber), event: $event, pid: $pid, details: $details, total_mem_mb: ($mem|tonumber), counts: $counts}'
    )
    
    echo "$json" >> "$EVENT_LOG"
    
    # Also log to timeline in human readable format
    echo "[$ts] #$EVENT_COUNT $event_type ${pid:+PID:$pid} $details [mem:${mem_total}MB, $proc_counts]" >> "$TIMELINE_LOG"
}

get_total_mem() {
    ps aux --no-headers 2>/dev/null | grep -E "claude|claude-mem" | grep -v "claude-tracker\|claude-monitor" | awk '{sum+=$6} END {print int(sum/1024)}'
}

get_proc_counts() {
    local claude_count=$(pgrep -c -f "claude" 2>/dev/null | grep -v "tracker\|monitor" || echo 0)
    local mcp_count=$(pgrep -c -f "claude-mem.*mcp-server" 2>/dev/null || echo 0)
    echo "claude:$claude_count,mcp:$mcp_count"
}

get_process_info() {
    local pid=$1
    if [ -d "/proc/$pid" ]; then
        local stat=$(cat /proc/$pid/stat 2>/dev/null || echo "")
        local cmdline=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 200 || echo "")
        local mem_kb=$(awk '/VmRSS/{print $2}' /proc/$pid/status 2>/dev/null || echo 0)
        local state=$(echo "$stat" | awk '{print $3}')
        local ppid=$(echo "$stat" | awk '{print $4}')
        local start_time=$(echo "$stat" | awk '{print $22}')
        echo "$mem_kb:$state:$ppid:$start_time:$cmdline"
    else
        echo ""
    fi
}

detect_process_type() {
    local cmdline="$1"
    if [[ "$cmdline" =~ "mcp-server.cjs" ]]; then
        echo "mcp-server"
    elif [[ "$cmdline" =~ "worker-service.cjs" ]]; then
        echo "worker-service"
    elif [[ "$cmdline" =~ "chroma-mcp" ]] || [[ "$cmdline" =~ "chroma" ]]; then
        echo "chroma"
    elif [[ "$cmdline" =~ claude ]] && [[ ! "$cmdline" =~ "mcp-server" ]] && [[ ! "$cmdline" =~ "worker-service" ]]; then
        echo "claude-code"
    else
        echo "other"
    fi
}

# Track which anomalies we've already seen
SEEN_HIGH_COUNT=""
SEEN_HIGH_MEM=""

check_for_anomalies() {
    local claude_count=$1
    local mcp_count=$2
    local mem_mb=$3
    
    # Check for high instance count (only alert on first occurrence or when count increases)
    if [ "$claude_count" -ge 5 ]; then
        if [ "$SEEN_HIGH_COUNT" != "$claude_count" ]; then
            SEEN_HIGH_COUNT="$claude_count"
            ((ANOMALY_COUNT++))
            log_event "ANOMALY" "" "High Claude instance count: $claude_count (threshold: 5)"
            echo -e "${YELLOW}⚠️  ANOMALY #$ANOMALY_COUNT: High instance count ($claude_count)${NC}"
        fi
    else
        SEEN_HIGH_COUNT=""
    fi
    
    # Check memory threshold (alert at each 2GB increment)
    local mem_tier=$((mem_mb / 2000))
    if [ "$mem_mb" -gt 6000 ]; then
        if [ "$SEEN_HIGH_MEM" != "$mem_tier" ]; then
            SEEN_HIGH_MEM="$mem_tier"
            ((ANOMALY_COUNT++))
            log_event "ANOMALY" "" "High memory usage: ${mem_mb}MB (threshold: 6000MB)"
            echo -e "${YELLOW}⚠️  ANOMALY #$ANOMALY_COUNT: High memory (${mem_mb}MB)${NC}"
        fi
    fi
}

scan_processes() {
    declare -A CURRENT_PROCS=()
    
    # Get all Claude-related processes
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local pid=$(echo "$line" | awk '{print $2}')
        
        # Skip self
        [[ "$pid" == "$$" ]] && continue
        [[ "$line" =~ "claude-tracker" ]] && continue
        [[ "$line" =~ "claude-monitor" ]] && continue
        
        local info=$(get_process_info "$pid")
        [ -z "$info" ] && continue
        
        local mem_kb=$(echo "$info" | cut -d: -f1)
        local state=$(echo "$info" | cut -d: -f2)
        local ppid=$(echo "$info" | cut -d: -f3)
        local start_time=$(echo "$info" | cut -d: -f4)
        local cmdline=$(echo "$info" | cut -d: -f5-)
        local proc_type=$(detect_process_type "$cmdline")
        local mem_mb=$((mem_kb / 1024))
        
        CURRENT_PROCS[$pid]="$proc_type:$mem_mb:$state:$ppid:$start_time"
        
        # Check for new processes
        if [ -z "${PREV_PROCS[$pid]:-}" ]; then
            PROC_BIRTH[$pid]=$(date +%s)
            
            local parent_info=""
            if [ "$proc_type" = "mcp-server" ] && [ -n "$ppid" ]; then
                local parent_cmd=$(ps -o comm= -p "$ppid" 2>/dev/null || echo "unknown")
                parent_info="parent=$ppid($parent_cmd)"
                if [[ "$parent_cmd" =~ "claude" ]]; then
                    MCP_PARENT[$pid]=$ppid
                fi
            fi
            
            log_event "SPAWN" "$pid" "$proc_type ${mem_mb}MB state=$state $parent_info"
            echo -e "${GREEN}▲ SPAWN${NC} PID:$pid ${CYAN}$proc_type${NC} ${mem_mb}MB $parent_info"
        else
            # Check for state changes
            local prev_state=$(echo "${PREV_PROCS[$pid]}" | cut -d: -f3)
            local prev_mem=$(echo "${PREV_PROCS[$pid]}" | cut -d: -f2)
            
            if [ "$state" != "$prev_state" ]; then
                log_event "STATE_CHANGE" "$pid" "$proc_type $prev_state->$state"
                echo -e "${YELLOW}◆ STATE${NC} PID:$pid ${CYAN}$proc_type${NC} $prev_state → $state"
            fi
            
            # Check for significant memory change (>100MB)
            local mem_diff=$((mem_mb - prev_mem))
            if [ "${mem_diff#-}" -gt 100 ]; then
                log_event "MEM_CHANGE" "$pid" "$proc_type ${prev_mem}MB->${mem_mb}MB (${mem_diff:0:1}${mem_diff#-}MB)"
                echo -e "${MAGENTA}◇ MEM${NC} PID:$pid ${CYAN}$proc_type${NC} ${prev_mem}→${mem_mb}MB"
            fi
        fi
    done <<< "$(ps aux --no-headers | grep -E "claude" | grep -v grep)"
    
    # Check for dead processes
    for pid in "${!PREV_PROCS[@]}"; do
        if [ -z "${CURRENT_PROCS[$pid]:-}" ]; then
            local prev_info="${PREV_PROCS[$pid]}"
            local proc_type=$(echo "$prev_info" | cut -d: -f1)
            local mem_mb=$(echo "$prev_info" | cut -d: -f2)
            local lifetime=""
            
            if [ -n "${PROC_BIRTH[$pid]:-}" ]; then
                local birth=${PROC_BIRTH[$pid]}
                local now=$(date +%s)
                local age=$((now - birth))
                lifetime="lived ${age}s"
                unset PROC_BIRTH[$pid]
            fi
            
            # Check if this was a parent of an MCP
            local orphaned_mcp=""
            for mcp_pid in "${!MCP_PARENT[@]}"; do
                if [ "${MCP_PARENT[$mcp_pid]}" = "$pid" ]; then
                    orphaned_mcp="orphaned MCP:$mcp_pid"
                    log_event "ORPHAN" "$mcp_pid" "mcp-server orphaned by death of $pid"
                    echo -e "${RED}☠ ORPHAN${NC} MCP PID:$mcp_pid (parent $pid died)"
                fi
            done
            
            log_event "EXIT" "$pid" "$proc_type ${mem_mb}MB $lifetime $orphaned_mcp"
            echo -e "${RED}▼ EXIT${NC} PID:$pid ${CYAN}$proc_type${NC} ${mem_mb}MB $lifetime"
        fi
    done
    
    # Update previous state
    PREV_PROCS=()
    for pid in "${!CURRENT_PROCS[@]}"; do
        PREV_PROCS[$pid]="${CURRENT_PROCS[$pid]}"
    done
    
    # Count and check for anomalies
    local claude_count=0
    local mcp_count=0
    local total_mem=0
    for pid in "${!CURRENT_PROCS[@]}"; do
        local info="${CURRENT_PROCS[$pid]}"
        local ptype=$(echo "$info" | cut -d: -f1)
        local pmem=$(echo "$info" | cut -d: -f2)
        total_mem=$((total_mem + pmem))
        [[ "$ptype" == "claude-code" ]] && ((claude_count++))
        [[ "$ptype" == "mcp-server" ]] && ((mcp_count++))
    done
    
    check_for_anomalies "$claude_count" "$mcp_count" "$total_mem"
}

print_status_bar() {
    local claude_count=$(pgrep -c -f "/claude|^claude " 2>/dev/null || echo 0)
    local mcp_count=$(pgrep -c -f "claude-mem.*mcp-server" 2>/dev/null || echo 0)
    local mem_mb=$(get_total_mem)
    local uptime=$(($(date +%s) - START_TIME))
    local uptime_str=$(printf '%02d:%02d:%02d' $((uptime/3600)) $((uptime%3600/60)) $((uptime%60)))
    
    echo -ne "\r${BOLD}[${uptime_str}]${NC} Claude:${CYAN}$claude_count${NC} MCP:${CYAN}$mcp_count${NC} Mem:${CYAN}${mem_mb}MB${NC} Events:${GREEN}$EVENT_COUNT${NC} Anomalies:${RED}$ANOMALY_COUNT${NC}    "
}

show_summary() {
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════${NC}"
    echo -e "${BOLD}Session Summary${NC}"
    echo -e "${BOLD}═══════════════════════════════════════${NC}"
    echo "Session ID: $SESSION_ID"
    echo "Duration: $(($(date +%s) - START_TIME)) seconds"
    echo "Total events: $EVENT_COUNT"
    echo "Anomalies detected: $ANOMALY_COUNT"
    echo ""
    echo "Event log: $EVENT_LOG"
    echo "Timeline:  $TIMELINE_LOG"
    echo ""
    
    if [ -f "$EVENT_LOG" ] && [ -s "$EVENT_LOG" ]; then
        echo -e "${BOLD}Event breakdown:${NC}"
        jq -r '.event' "$EVENT_LOG" | sort | uniq -c | sort -rn
        
        echo ""
        echo -e "${BOLD}Anomalies:${NC}"
        grep "ANOMALY" "$EVENT_LOG" | jq -r '"\(.ts): \(.details)"' 2>/dev/null || echo "None"
    fi
}

cleanup() {
    echo ""
    echo -e "${YELLOW}Stopping tracker...${NC}"
    log_event "SESSION_END" "" "Tracker stopped by user"
    show_summary
    exit 0
}

# Main
trap cleanup SIGINT SIGTERM

START_TIME=$(date +%s)

echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Claude Code Process Lifecycle Tracker              ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Session: ${CYAN}$SESSION_ID${NC}"
echo -e "Logs:    ${CYAN}$LOG_DIR${NC}"
echo -e "Press ${YELLOW}Ctrl+C${NC} to stop and see summary"
echo ""
echo -e "${BOLD}Legend:${NC} ${GREEN}▲ SPAWN${NC} | ${RED}▼ EXIT${NC} | ${YELLOW}◆ STATE${NC} | ${MAGENTA}◇ MEM${NC} | ${RED}☠ ORPHAN${NC}"
echo ""

log_event "SESSION_START" "" "Tracker started, poll interval: ${POLL_INTERVAL}s"

# Initial scan
echo -e "${BOLD}Initial scan...${NC}"
scan_processes
echo ""

# Main loop
while true; do
    sleep "$POLL_INTERVAL"
    scan_processes
    print_status_bar
done
