#!/bin/bash
# Analyze a tracker session to find patterns and breaking points

LOG_DIR="/home/dev/clawd/monitors/logs"

usage() {
    echo "Usage: $0 [session_id|latest|all]"
    echo ""
    echo "Examples:"
    echo "  $0 latest          # Analyze most recent session"
    echo "  $0 20260124_193000 # Analyze specific session"
    echo "  $0 all             # Summary of all sessions"
    echo ""
    echo "Available sessions:"
    ls -1 "$LOG_DIR"/session_*_events.jsonl 2>/dev/null | sed 's/.*session_\(.*\)_events.jsonl/  \1/' | head -10
}

analyze_session() {
    local session_id="$1"
    local event_log="$LOG_DIR/session_${session_id}_events.jsonl"
    local timeline_log="$LOG_DIR/session_${session_id}_timeline.log"
    
    if [ ! -f "$event_log" ]; then
        echo "Session not found: $session_id"
        return 1
    fi
    
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  Session Analysis: $session_id"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    
    # Basic stats
    local total_events=$(wc -l < "$event_log")
    local first_ts=$(head -1 "$event_log" | jq -r '.ts')
    local last_ts=$(tail -1 "$event_log" | jq -r '.ts')
    local spawns=$(grep -c '"event":"SPAWN"' "$event_log" || echo 0)
    local exits=$(grep -c '"event":"EXIT"' "$event_log" || echo 0)
    local anomalies=$(grep -c '"event":"ANOMALY"' "$event_log" || echo 0)
    local orphans=$(grep -c '"event":"ORPHAN"' "$event_log" || echo 0)
    
    echo "📊 Overview:"
    echo "   Time range: $first_ts → $last_ts"
    echo "   Total events: $total_events"
    echo "   Spawns: $spawns | Exits: $exits"
    echo "   Anomalies: $anomalies | Orphans: $orphans"
    echo ""
    
    # Process lifecycle
    echo "🔄 Process Lifecycle:"
    echo ""
    
    # Track concurrent instances over time
    echo "   Peak concurrent Claude instances:"
    jq -r 'select(.event == "SPAWN" or .event == "EXIT") | "\(.ts) \(.event) \(.counts)"' "$event_log" | \
    awk -F'[: ,]' '
    BEGIN { max=0; max_ts="" }
    /claude:/ {
        for(i=1; i<=NF; i++) {
            if($i == "claude") {
                count = $(i+1)
                if(count > max) { max=count; max_ts=$1 }
            }
        }
    }
    END { print "   → Maximum: " max " at " max_ts }
    '
    
    echo ""
    
    # Find breaking points (events just before anomalies)
    echo "🔍 Breaking Points (5 events before each anomaly):"
    echo ""
    
    local anomaly_nums=$(jq -r 'select(.event == "ANOMALY") | .event_num' "$event_log")
    
    if [ -z "$anomaly_nums" ]; then
        echo "   No anomalies detected in this session"
    else
        while read -r anomaly_num; do
            [ -z "$anomaly_num" ] && continue
            echo "   ─── Before Anomaly at event #$anomaly_num ───"
            local start=$((anomaly_num - 5))
            [ "$start" -lt 1 ] && start=1
            
            jq -r "select(.event_num >= $start and .event_num <= $anomaly_num) | \"   #\(.event_num) \(.ts | split(\"T\")[1] | split(\".\")[0]) \(.event) \(.details[:60])\"" "$event_log"
            echo ""
        done <<< "$anomaly_nums"
    fi
    
    # Memory trajectory
    echo "📈 Memory Trajectory:"
    echo ""
    jq -r 'select(.event == "SPAWN" or .event == "EXIT" or .event == "ANOMALY") | "\(.ts | split("T")[1] | split(".")[0]) \(.total_mem_mb)MB \(.event)"' "$event_log" | head -20
    echo "   ..."
    jq -r 'select(.event == "SPAWN" or .event == "EXIT" or .event == "ANOMALY") | "\(.ts | split("T")[1] | split(".")[0]) \(.total_mem_mb)MB \(.event)"' "$event_log" | tail -5
    
    echo ""
    
    # MCP/Claude relationship
    echo "🔗 MCP/Claude Relationship:"
    echo ""
    echo "   Spawn order (who spawned whom):"
    jq -r 'select(.event == "SPAWN") | "   \(.ts | split("T")[1] | split(".")[0]) \(.pid): \(.details)"' "$event_log" | head -15
    
    echo ""
    
    # Orphan analysis
    if [ "$orphans" -gt 0 ]; then
        echo "☠️  Orphan Events:"
        jq -r 'select(.event == "ORPHAN") | "   \(.ts): PID \(.pid) - \(.details)"' "$event_log"
        echo ""
    fi
    
    # State changes (processes getting stuck)
    local state_changes=$(grep -c '"event":"STATE_CHANGE"' "$event_log" || echo 0)
    if [ "$state_changes" -gt 0 ]; then
        echo "⚠️  State Changes (processes stopping/resuming):"
        jq -r 'select(.event == "STATE_CHANGE") | "   \(.ts | split("T")[1] | split(".")[0]) PID \(.pid): \(.details)"' "$event_log" | head -10
        echo ""
    fi
    
    # Pattern detection
    echo "🧩 Pattern Analysis:"
    echo ""
    
    # Find if anomalies correlate with specific instance counts
    echo "   Instance count when anomalies occurred:"
    jq -r 'select(.event == "ANOMALY") | .counts' "$event_log" | sort | uniq -c | sort -rn | head -5
    
    echo ""
    
    # Time between spawns (detect rapid spawning)
    echo "   Rapid spawn detection (spawns within 5s of each other):"
    jq -r 'select(.event == "SPAWN" and (.details | contains("claude-code"))) | .ts' "$event_log" | \
    awk '
    BEGIN { prev=0; count=0 }
    {
        gsub(/[TZ:-]/, " ", $0)
        cmd = "date -d \"" $0 "\" +%s"
        cmd | getline ts
        close(cmd)
        if(prev > 0 && ts - prev < 5) {
            count++
            if(count == 1) print "   Found rapid spawns:"
            print "     " $0 " (+" (ts-prev) "s from previous)"
        }
        prev = ts
    }
    END { if(count == 0) print "   No rapid spawns detected" }
    ' 2>/dev/null || echo "   Unable to analyze spawn timing"
}

analyze_all() {
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  All Sessions Summary"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    
    printf "%-20s %8s %8s %8s %8s\n" "Session" "Events" "Spawns" "Anomaly" "Orphans"
    echo "──────────────────────────────────────────────────────────────"
    
    for event_log in "$LOG_DIR"/session_*_events.jsonl; do
        [ ! -f "$event_log" ] && continue
        local session=$(basename "$event_log" | sed 's/session_\(.*\)_events.jsonl/\1/')
        local events=$(wc -l < "$event_log")
        local spawns=$(grep -c '"event":"SPAWN"' "$event_log" || echo 0)
        local anomalies=$(grep -c '"event":"ANOMALY"' "$event_log" || echo 0)
        local orphans=$(grep -c '"event":"ORPHAN"' "$event_log" || echo 0)
        
        printf "%-20s %8d %8d %8d %8d\n" "$session" "$events" "$spawns" "$anomalies" "$orphans"
    done
    
    echo ""
    echo "Cross-session anomaly patterns:"
    echo ""
    
    # Aggregate anomaly reasons across sessions
    cat "$LOG_DIR"/session_*_events.jsonl 2>/dev/null | \
    jq -r 'select(.event == "ANOMALY") | .details' | \
    sort | uniq -c | sort -rn | head -10
}

# Main
case "${1:-}" in
    latest)
        latest=$(ls -1t "$LOG_DIR"/session_*_events.jsonl 2>/dev/null | head -1 | sed 's/.*session_\(.*\)_events.jsonl/\1/')
        if [ -z "$latest" ]; then
            echo "No sessions found"
            exit 1
        fi
        analyze_session "$latest"
        ;;
    all)
        analyze_all
        ;;
    "")
        usage
        ;;
    *)
        analyze_session "$1"
        ;;
esac
