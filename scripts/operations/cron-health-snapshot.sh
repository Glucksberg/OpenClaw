#!/usr/bin/env bash
set +e
umask 077

probe_id="all"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --all)
      probe_id="all"
      shift
      ;;
    --probe)
      probe_id="${2:-}"
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

case "$probe_id" in
  all|system-cron|carryover|seedsearch|pm2|disk|tasks|disabled-crons|registry) ;;
  *)
    printf 'unknown probe id: %s\n' "$probe_id" >&2
    exit 2
    ;;
esac

selected() {
  [ "$probe_id" = "all" ] || [ "$probe_id" = "$1" ]
}

now_epoch=$(date +%s)
health_crontab_file="${OPENCLAW_HEALTH_CRONTAB_FILE:-}"
health_registry_file="${OPENCLAW_HEALTH_REGISTRY_FILE:-/home/dev/.openclaw/task-registry.md}"
health_tools_file="${OPENCLAW_HEALTH_TOOLS_FILE:-/home/dev/.openclaw/workspace-openclaw/TOOLS.md}"

read_crontab() {
  if [ -n "$health_crontab_file" ]; then
    cat "$health_crontab_file" 2>/dev/null
  else
    crontab -l 2>/dev/null
  fi
}

cron_schedule_status() {
  local name="$1"
  local schedule="$2"
  local marker="$3"
  local expected_count="${4:-1}"
  local command_count="0"
  local exact_count="0"

  command_count=$(read_crontab | grep -F -c "$marker" || true)
  exact_count=$(read_crontab | awk -v schedule="$schedule" -v marker="$marker" '
    BEGIN { split(schedule, expected, " ") }
    /^[[:space:]]*#/ { next }
    NF >= 6 && $1 == expected[1] && $2 == expected[2] && $3 == expected[3] && $4 == expected[4] && $5 == expected[5] && index($0, marker) > 0 { count += 1 }
    END { print count + 0 }
  ')

  if [ "$exact_count" = "1" ] && [ "$command_count" = "$expected_count" ]; then
    printf 'HEALTH|ok|system-cron|schedule_present|%s\n' "$name"
  elif [ "$command_count" = "0" ]; then
    printf 'HEALTH|critical|system-cron|schedule_missing|%s\n' "$name"
  elif [ "$exact_count" = "0" ]; then
    printf 'HEALTH|critical|system-cron|schedule_drift|%s count=%s\n' "$name" "$command_count"
  else
    printf 'HEALTH|critical|system-cron|schedule_duplicate|%s count=%s\n' "$name" "$command_count"
  fi
}

age_minutes() {
  local path="$1"
  if [ -f "$path" ]; then
    echo $(( (now_epoch - $(stat -c %Y "$path" 2>/dev/null || echo "$now_epoch")) / 60 ))
  else
    echo "missing"
  fi
}

mtime_epoch() {
  local path="$1"
  if [ -e "$path" ]; then
    stat -c %Y "$path" 2>/dev/null || true
  fi
}

log_matches() {
  local path="$1"
  if [ -f "$path" ]; then
    tail -c 20000 "$path" 2>/dev/null \
      | sed 's/}{/}\n{/g' \
      | tail -20 \
      | grep -v '"success":true.*"errors":0' \
      | grep -inE 'fatal|exception|panic|segfault|killed|ENOENT|EACCES|EPERM|exit code [1-9]|(^|[^[:alpha:]])errors?[=: ]+[1-9]|(^|[^[:alpha:]])error([^[:alpha:]]|$)|Error|ERROR' \
      | tail -5 \
      | tr '\n' '\036'
  fi
}

metrics_matches() {
  local path="$1"
  local latest_run=""

  if [ ! -f "$path" ]; then
    return
  fi

  latest_run=$(tail -c 20000 "$path" 2>/dev/null \
    | awk '/🔄 Gerando relatório de métricas/{buffer=""} {buffer = buffer $0 ORS} END {printf "%s", buffer}')

  if printf '%s' "$latest_run" | grep -q '✅ Relatório enviado para o grupo' \
    && ! printf '%s' "$latest_run" | grep -qE 'Erro fatal|💥|❌'; then
    return
  fi

  printf '%s' "$latest_run" \
    | grep -inE 'fatal|exception|panic|segfault|killed|ENOENT|EACCES|EPERM|exit code [1-9]|(^|[^[:alpha:]])errors?[=: ]+[1-9]|(^|[^[:alpha:]])error([^[:alpha:]]|$)|Error|ERROR|💥|❌' \
    | tail -5 \
    | tr '\n' '\036'
}

backup_matches() {
  local path="$1"
  local latest_manifest=""
  local failed=""

  latest_manifest=$(find /home/dev/backups/daily -mindepth 2 -maxdepth 2 -name manifest.json -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr \
    | head -1 \
    | cut -d' ' -f2-)

  if [ -n "$latest_manifest" ] && command -v jq >/dev/null 2>&1; then
    failed=$(jq -r '.summary.failed // ([.databases[]? | select(.status != "ok")] | length) // "unknown"' "$latest_manifest" 2>/dev/null)
    if [ "$failed" = "0" ]; then
      return
    fi
    printf 'manifest:%s failed=%s\036' "$latest_manifest" "$failed"
    return
  fi

  log_matches "$path"
}

last_line() {
  local path="$1"
  if [ -f "$path" ]; then
    tail -c 2000 "$path" 2>/dev/null | sed 's/}{/}\n{/g' | tail -1 | tr '\n' ' '
  fi
}

entry() {
  local name="$1"
  local schedule="$2"
  local script="$3"
  local log="$4"
  local expect_min="$5"
  local matcher="${6:-log_matches}"
  local cron_marker="${7:-$script}"
  local cron_marker_count="${8:-1}"
  local exists="no"

  if [ "$script" = "INLINE_CURL" ]; then
    exists="inline"
  elif [ -f "$script" ]; then
    exists="yes"
  fi

  printf 'ENTRY|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$name" \
    "$schedule" \
    "$script" \
    "$exists" \
    "$log" \
    "$(age_minutes "$log")" \
    "$expect_min" \
    "$(mtime_epoch "$script")" \
    "$(mtime_epoch "$log")" \
    "$(last_line "$log")"

  printf 'MATCHES|%s|%s\n' "$name" "$("$matcher" "$log" "$name")"
  cron_schedule_status "$name" "$schedule" "$cron_marker" "$cron_marker_count"
}

seedsearch_catalog_artifact() {
  local dir="/home/dev/projects/seedsearch/app/reports/current/source-cron-runs"
  local latest=""

  if [ ! -d "$dir" ]; then
    echo "catalog_report_status=missing_dir"
    return
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "catalog_report_status=jq_missing"
    return
  fi

  while IFS= read -r candidate; do
    if [ "$(jq -r '.group // empty' "$candidate" 2>/dev/null)" = "catalog-discovery" ]; then
      latest="$candidate"
      break
    fi
  done < <(ls -t "$dir"/source-refresh-*.json 2>/dev/null)

  if [ -z "$latest" ]; then
    echo "catalog_report_status=missing"
    return
  fi

  local mtime
  local age_min
  local dry_run
  local total
  local result_count
  local success_count
  local error_count
  local finished_at
  mtime=$(mtime_epoch "$latest")
  age_min=$(age_minutes "$latest")
  dry_run=$(jq -r 'if has("dryRun") then (.dryRun | tostring) else "missing" end' "$latest" 2>/dev/null)
  total=$(jq -r '.total // "missing"' "$latest" 2>/dev/null)
  result_count=$(jq -r '(.results // []) | length' "$latest" 2>/dev/null)
  success_count=$(jq -r '(.results // []) | map(select((.status // "") == "success")) | length' "$latest" 2>/dev/null)
  error_count=$(jq -r '(.results // []) | map(select((.status // "") != "success")) | length' "$latest" 2>/dev/null)
  finished_at=$(jq -r '.finishedAt // "missing"' "$latest" 2>/dev/null)

  printf 'catalog_report_status=found\n'
  printf 'catalog_report_path=%s\n' "$latest"
  printf 'catalog_report_mtime=%s\n' "$mtime"
  printf 'catalog_report_age_min=%s\n' "$age_min"
  printf 'catalog_report_started_at=%s\n' "$(jq -r '.startedAt // "missing"' "$latest" 2>/dev/null)"
  printf 'catalog_report_finished_at=%s\n' "$finished_at"
  printf 'catalog_report_dry_run=%s\n' "$dry_run"
  printf 'catalog_report_total=%s\n' "$total"
  printf 'catalog_report_result_count=%s\n' "$result_count"
  printf 'catalog_report_success_count=%s\n' "$success_count"
  printf 'catalog_report_error_count=%s\n' "$error_count"

  if [ "$dry_run" != "false" ]; then
    echo "catalog_report_verdict=warn:latest_catalog_report_is_dry_run"
  elif [ "$finished_at" = "missing" ]; then
    echo "catalog_report_verdict=warn:latest_catalog_report_missing_finished_at"
  elif [ "$result_count" = "0" ]; then
    echo "catalog_report_verdict=warn:latest_catalog_report_has_no_results"
  elif [ "$error_count" != "0" ]; then
    echo "catalog_report_verdict=warn:latest_catalog_report_has_failed_results"
  else
    echo "catalog_report_verdict=ok"
  fi
}

pm2_process_snapshot() {
  local state_dir="/home/dev/.openclaw/workspace-openclaw/state"
  local state_file="${OPENCLAW_HEALTH_PM2_STATE_FILE:-$state_dir/pm2-restart-counts.json}"
  local current_file=""
  local prev_file=""
  local tmp_state=""
  local baseline="yes"
  local total="0"
  local online="0"

  state_dir=$(dirname "$state_file")

  printf 'PM2_STATE_FILE|%s\n' "$state_file"

  if ! command -v pm2 >/dev/null 2>&1; then
    echo "PM2_ANOMALY|critical|pm2|pm2_missing|pm2 command not found"
    echo "HEALTH|critical|pm2|pm2_missing|pm2 command not found"
    return
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "PM2_ANOMALY|critical|pm2|jq_missing|jq command not found"
    echo "HEALTH|critical|pm2|jq_missing|jq command not found"
    return
  fi

  mkdir -p "$state_dir" 2>/dev/null || true
  current_file=$(mktemp /tmp/cron-health-pm2-current.XXXXXX) || {
    echo "PM2_ANOMALY|critical|pm2|snapshot_temp_failed|could not create temp file"
    echo "HEALTH|critical|pm2|snapshot_temp_failed|could not create temp file"
    return
  }
  prev_file=$(mktemp /tmp/cron-health-pm2-prev.XXXXXX) || {
    echo "PM2_ANOMALY|critical|pm2|snapshot_temp_failed|could not create temp file"
    echo "HEALTH|critical|pm2|snapshot_temp_failed|could not create temp file"
    rm -f "$current_file"
    return
  }

  if ! pm2 jlist 2>/dev/null | sed -n '/^\[/,$p' | jq -c '[.[] | {
    key: (((.name // "unknown") | tostring) + "#" + ((.pm_id // -1) | tostring)),
    name: ((.name // "unknown") | tostring),
    pm_id: ((.pm_id // -1) | tonumber? // -1),
    status: ((.pm2_env.status // "unknown") | tostring),
    restart_time: ((.pm2_env.restart_time // 0) | tonumber? // 0),
    unstable_restarts: ((.pm2_env.unstable_restarts // 0) | tonumber? // 0),
    pid: ((.pid // 0) | tonumber? // 0),
    uptime_ms: ((.pm2_env.pm_uptime // 0) | tonumber? // 0),
    exec_path: ((.pm2_env.pm_exec_path // "") | tostring),
    cwd: ((.pm2_env.pm_cwd // "") | tostring)
  }]' > "$current_file"; then
    echo "PM2_ANOMALY|critical|pm2|jlist_failed|pm2 jlist could not be parsed"
    echo "HEALTH|critical|pm2|jlist_failed|pm2 jlist could not be parsed"
    rm -f "$current_file" "$prev_file"
    return
  fi

  if ! jq -e 'type == "array"' "$current_file" >/dev/null 2>&1; then
    echo "PM2_ANOMALY|critical|pm2|jlist_invalid|pm2 jlist did not produce a process array"
    echo "HEALTH|critical|pm2|jlist_invalid|pm2 jlist did not produce a process array"
    rm -f "$current_file" "$prev_file"
    return
  fi

  if [ -f "$state_file" ] && jq -e '.processes | type == "array"' "$state_file" >/dev/null 2>&1; then
    jq -c '.processes' "$state_file" > "$prev_file" 2>/dev/null || printf '[]\n' > "$prev_file"
    baseline="no"
  else
    printf '[]\n' > "$prev_file"
  fi

  total=$(jq 'length' "$current_file" 2>/dev/null || echo 0)
  online=$(jq '[.[] | select(.status == "online")] | length' "$current_file" 2>/dev/null || echo 0)
  printf 'PM2_STATUS|total=%s|online=%s|baseline=%s|restart_counters=delta_only\n' \
    "$total" "$online" "$baseline"

  jq -r --slurpfile prev "$prev_file" '
    def old_for($key): ($prev[0][]? | select(.key == $key));
    .[] as $p
    | ([old_for($p.key)] | .[0]) as $old
    | ($old.restart_time // null) as $prev_restart
    | (if $prev_restart == null or $p.restart_time < $prev_restart then 0 else ($p.restart_time - $prev_restart) end) as $delta
    | if $p.status != "online" then
        ["PM2_ANOMALY", "critical", $p.name, "status_not_online", ("status=" + $p.status)] | @tsv
      elif $delta >= 10 then
        ["PM2_ANOMALY", "critical", $p.name, "restart_delta_critical", ("delta=" + ($delta | tostring) + " previous=" + ($prev_restart | tostring) + " current=" + ($p.restart_time | tostring))] | @tsv
      elif $delta >= 3 then
        ["PM2_ANOMALY", "warning", $p.name, "restart_delta_warning", ("delta=" + ($delta | tostring) + " previous=" + ($prev_restart | tostring) + " current=" + ($p.restart_time | tostring))] | @tsv
      else
        empty
      end
  ' "$current_file" \
    | while IFS=$'\t' read -r record_type severity process_name anomaly_code detail; do
      printf '%s\t%s\t%s\t%s\t%s\n' "$record_type" "$severity" "$process_name" "$anomaly_code" "$detail"
      case "$record_type:$severity" in
        PM2_ANOMALY:critical|PM2_ANOMALY:warning)
          printf 'HEALTH|%s|pm2|%s|%s|%s\n' "$severity" "$anomaly_code" "$process_name" "$detail"
          ;;
        *)
          printf 'HEALTH|critical|pm2|malformed_anomaly|record_type=%s severity=%s\n' "$record_type" "$severity"
          ;;
      esac
    done

  jq -r '.[] | [.name, .exec_path] | @tsv' "$current_file" \
    | while IFS=$'\t' read -r name exec_path; do
      if [[ "$exec_path" == /home/dev/* ]] && [ ! -e "$exec_path" ]; then
        printf 'PM2_ANOMALY|critical|%s|script_missing|exec_path=%s\n' "$name" "$exec_path"
        printf 'HEALTH|critical|pm2|script_missing|%s exec_path=%s\n' "$name" "$exec_path"
      fi
    done

  tmp_state=$(mktemp /tmp/cron-health-pm2-state.XXXXXX) || {
    rm -f "$current_file" "$prev_file"
    echo "PM2_ANOMALY|warning|pm2|state_write_failed|could not create pm2 state candidate"
    echo "HEALTH|warning|pm2|state_write_failed|could not create pm2 state candidate"
    return
  }
  if jq -n --arg captured_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" --slurpfile processes "$current_file" \
    '{captured_at: $captured_at, processes: $processes[0]}' > "$tmp_state" 2>/dev/null; then
    if [ "${OPENCLAW_HEALTH_PM2_DEFER_COMMIT:-0}" = "1" ]; then
      printf 'PM2_STATE_CANDIDATE|%s\n' "$(base64 -w0 "$tmp_state")"
      echo "HEALTH|ok|pm2|snapshot_complete|candidate_ready"
    else
      mkdir -p "$(dirname "$state_file")" 2>/dev/null || true
      if mv "$tmp_state" "$state_file" 2>/dev/null; then
        echo "HEALTH|ok|pm2|snapshot_complete|baseline_committed"
      else
        echo "PM2_ANOMALY|warning|pm2|state_write_failed|could not commit pm2 restart-count baseline"
        echo "HEALTH|warning|pm2|state_write_failed|could not commit pm2 restart-count baseline"
      fi
    fi
  else
    rm -f "$tmp_state"
    echo "PM2_ANOMALY|warning|pm2|state_write_failed|could not write pm2 restart-count baseline"
    echo "HEALTH|warning|pm2|state_write_failed|could not write pm2 restart-count baseline"
  fi

  rm -f "$current_file" "$prev_file" "$tmp_state"
}

disk_snapshot() {
  local usage=""
  local available=""
  local severity="ok"

  usage=$(df -P / 2>/dev/null | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')
  available=$(df -hP / 2>/dev/null | awk 'NR == 2 {print $4}')

  if ! [[ "$usage" =~ ^[0-9]+$ ]]; then
    echo "DISK_STATUS|critical|root|unreadable|could not read root filesystem usage"
    return
  fi

  if [ "$usage" -ge 95 ]; then
    severity="critical"
  elif [ "$usage" -ge 85 ]; then
    severity="warning"
  fi

  printf 'DISK_STATUS|%s|root|used_percent=%s|available=%s\n' "$severity" "$usage" "${available:-unknown}"
}

task_audit_snapshot() {
  local audit=""

  if ! command -v openclaw >/dev/null 2>&1; then
    echo "TASK_AUDIT|critical|openclaw_missing"
    return
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "TASK_AUDIT|critical|jq_missing"
    return
  fi

  audit=$(openclaw tasks audit --json 2>/dev/null)
  if ! printf '%s' "$audit" | jq -e '.summary.combined' >/dev/null 2>&1; then
    echo "TASK_AUDIT|critical|audit_unreadable"
    return
  fi

  printf '%s' "$audit" | jq -r '
    .summary as $s
    | [
        "TASK_AUDIT",
        (if ($s.combined.errors // 0) > 0 then "critical"
         elif ($s.combined.warnings // 0) > 0 then "warning"
         else "ok" end),
        "combined=" + (($s.combined.total // 0) | tostring),
        "errors=" + (($s.combined.errors // 0) | tostring),
        "warnings=" + (($s.combined.warnings // 0) | tostring),
        "lost=" + (($s.byCode.lost // 0) | tostring),
        "delivery_failed=" + (($s.byCode.delivery_failed // 0) | tostring),
        "stale_running=" + (($s.byCode.stale_running // 0) | tostring),
        "stale_blocked_flows=" + (($s.taskFlows.byCode.stale_blocked // 0) | tostring),
        "missing_blocked_tasks=" + (($s.taskFlows.byCode.blocked_task_missing // 0) | tostring)
      ] | join("|")
  '
}

disabled_gateway_crons() {
  local db="/home/dev/.openclaw/state/openclaw.sqlite"
  local docs="/home/dev/.openclaw/cron/disabled-jobs.json"
  local query

  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "DISABLED_GATEWAY_CRON_STATUS|critical|sqlite3_missing|sqlite3 command not found"
    return
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "DISABLED_GATEWAY_CRON_STATUS|critical|jq_missing|jq command not found"
    return
  fi

  if [ ! -f "$db" ]; then
    printf 'DISABLED_GATEWAY_CRON_STATUS|critical|db_missing|%s\n' "$db"
    return
  fi

  if [ ! -f "$docs" ]; then
    printf 'DISABLED_GATEWAY_CRON_STATUS|warning|docs_missing|%s\n' "$docs"
  fi

  query="
    select
      job_id,
      name,
      strftime('%Y-%m-%dT%H:%M:%SZ', updated_at / 1000, 'unixepoch'),
      coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', last_run_at_ms / 1000, 'unixepoch'), ''),
      coalesce(last_run_status, '')
    from cron_jobs
    where enabled = 0
    order by updated_at;
  "

  sqlite3 -readonly -separator $'\t' "$db" "$query" 2>/dev/null \
    | while IFS=$'\t' read -r job_id name disabled_since last_run last_status; do
      local reason=""
      local revisit=""
      local documented_since=""
      local status="documented"

      if [ -f "$docs" ]; then
        reason=$(jq -r --arg id "$job_id" '.jobs[$id].reason // "" | gsub("[\t\r\n]+"; " ")' "$docs" 2>/dev/null)
        revisit=$(jq -r --arg id "$job_id" '.jobs[$id].revisit // "" | gsub("[\t\r\n]+"; " ")' "$docs" 2>/dev/null)
        documented_since=$(jq -r --arg id "$job_id" '.jobs[$id].disabledSince // ""' "$docs" 2>/dev/null)
      fi

      if [ -z "$reason" ]; then
        status="undocumented"
        reason="missing disabled reason"
      elif [ -z "$revisit" ]; then
        status="reason_missing_revisit"
        revisit="missing revisit policy"
      elif [ -n "$documented_since" ] && [ "$documented_since" != "$disabled_since" ]; then
        status="disabled_since_mismatch"
      fi

      printf 'DISABLED_GATEWAY_CRON|%s|%s|%s|disabled_since=%s|last_run=%s|last_status=%s|reason=%s|revisit=%s\n' \
        "$status" \
        "$job_id" \
        "$name" \
        "$disabled_since" \
        "${last_run:-none}" \
        "${last_status:-unknown}" \
        "$reason" \
        "${revisit:-none}"
    done

  if [ -f "$docs" ]; then
    jq -r '.jobs | to_entries[] | [.key, (.value.name // "")] | @tsv' "$docs" 2>/dev/null \
      | while IFS=$'\t' read -r documented_id documented_name; do
        if ! sqlite3 -readonly "$db" "select 1 from cron_jobs where enabled = 0 and job_id = '$documented_id' limit 1;" 2>/dev/null | grep -q 1; then
          printf 'DISABLED_GATEWAY_CRON_DOC|warning|%s|%s|documented_but_not_disabled\n' "$documented_id" "$documented_name"
        fi
      done
  fi
}

disabled_system_crons() {
  local reason=""
  local date=""

  read_crontab | while IFS= read -r line; do
    if [[ "$line" =~ ^#\ PAUSED[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2}):(.*)$ ]]; then
      date="${BASH_REMATCH[1]}"
      reason="$(printf '%s' "${BASH_REMATCH[2]}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+/ /g')"
      continue
    fi

    if [[ "$line" =~ ^#\ PAUSED:[[:space:]]*(.*)$ ]]; then
      local command="${BASH_REMATCH[1]}"
      if [ -n "$reason" ]; then
        printf 'DISABLED_SYSTEM_CRON|documented|paused_since=%s|reason=%s|command=%s\n' "$date" "$reason" "$command"
      else
        printf 'DISABLED_SYSTEM_CRON|undocumented|paused_since=unknown|reason=missing pause reason|command=%s\n' "$command"
      fi
      reason=""
      date=""
    fi
  done
}

if selected system-cron; then
  echo "===DATE==="
  date -u +"%Y-%m-%dT%H:%M:%SZ"

  echo "===CRONTAB_RAW==="
  read_crontab \
    | sed -E 's/(Authorization: Bearer )[A-Za-z0-9._-]+/\1***REDACTED***/g' \
    || true

  echo "===SYSTEM_CRON_DETAIL==="
  entry "Release Monitor" "0 * * * *" \
    "/home/dev/projects/CloudFarm/apps/backend/scripts/releaseMonitor.js" \
    "/home/dev/projects/CloudFarm/apps/backend/logs/release-monitor.log" 120
  entry "CloudFarm Metrics Reporter (06:00 UTC)" "0 6 * * *" \
    "/home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js" \
    "/home/dev/projects/CloudFarm/agents/opsec/metrics-cron.log" 600 metrics_matches \
    "/home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js" 3
  entry "CloudFarm Metrics Reporter (14:00 UTC)" "0 14 * * *" \
    "/home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js" \
    "/home/dev/projects/CloudFarm/agents/opsec/metrics-cron.log" 600 metrics_matches \
    "/home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js" 3
  entry "CloudFarm Metrics Reporter (22:00 UTC)" "0 22 * * *" \
    "/home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js" \
    "/home/dev/projects/CloudFarm/agents/opsec/metrics-cron.log" 600 metrics_matches \
    "/home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js" 3
  entry "CloudFarm Weekly Metrics Reporter" "0 17 * * 5" \
    "/home/dev/projects/CloudFarm/agents/opsec/scripts/weekly-metrics-reporter.js" \
    "/home/dev/projects/CloudFarm/agents/opsec/weekly-metrics-cron.log" 11520
  entry "Backup diario de bancos de dados" "20 3 * * *" \
    "/home/dev/scripts/backup-all-databases.sh" \
    "/home/dev/backups/backup.log" 1560 backup_matches
  entry "Weekly disk cleanup" "0 4 * * 0" \
    "/home/dev/tools/weekly-cleanup" \
    "/home/dev/tools/.weekly-cleanup.log" 11520
  entry "CreDSys Notificacoes" "0 7 * * *" \
    "INLINE_CURL" \
    "/home/dev/projects/credsys/logs/cron-notificacoes.log" 1560 log_matches \
    "cron-notificacoes.log"
  if read_crontab | grep -Eq '^[[:space:]]*15[[:space:]]+10[[:space:]]+\*[[:space:]]+\*[[:space:]]+\*.*simulateTeste777TaskDays\.js'; then
    entry "CloudFarm Tarefas Demo Simulator" "15 10 * * *" \
      "/home/dev/projects/CloudFarm/apps/backend/scripts/simulateTeste777TaskDays.js" \
      "/home/dev/projects/CloudFarm/apps/backend/logs/task-demo-simulation.log" 1560
  fi
fi

if [ "$probe_id" = "all" ]; then
  echo "===DISABLED_SYSTEM_CRONS==="
  disabled_system_crons
elif selected disabled-crons; then
  echo "===DISABLED_SYSTEM_CRONS==="
  disabled_system_crons
  echo "===DISABLED_GATEWAY_CRONS==="
  disabled_gateway_crons
fi

if selected carryover; then
  echo "===CARRYOVER_DETAIL==="
  total=$(find /home/dev/.openclaw/workspace-*/memory/last-conversation.md 2>/dev/null | wc -l)
  stale=$(find /home/dev/.openclaw/workspace-*/memory/last-conversation.md -mmin +10 2>/dev/null | wc -l)
  latest=$(find /home/dev/.openclaw/workspace-*/memory/last-conversation.md -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
  printf 'Carryover plugin: %s\n' "$(jq -r '.plugins.entries["conversation-carryover"].enabled // false' /home/dev/.openclaw/openclaw.json 2>/dev/null || echo false)"
  printf 'Carryover files: %s total, %s stale (>10min, expected for idle workspaces)\n' "$total" "$stale"
  printf 'Carryover latest: %s\n' "${latest:-none}"
  printf 'crontab_conversation_carryover=%s\n' "$(read_crontab | grep -c conversation-carryover || true)"
fi

if selected seedsearch; then
  echo "===SEEDSEARCH_DRY_RUN==="
  if [ -d /home/dev/projects/seedsearch/app ]; then
    (
      cd /home/dev/projects/seedsearch/app && \
        npm run cron:source-refresh -- --dry-run
    )
    printf 'seedsearch_exit=%s\n' "$?"
  else
    echo "seedsearch_app_missing"
  fi
  echo "===SEEDSEARCH_ARTIFACT_PROOF==="
  seedsearch_catalog_artifact
fi

if selected pm2; then
  echo "===PM2_PROCESS_DETAIL==="
  pm2_process_snapshot
fi

if selected disk; then
  echo "===DISK_DETAIL==="
  disk_snapshot
fi

if selected tasks; then
  echo "===TASK_AUDIT_DETAIL==="
  task_audit_snapshot
fi

if [ "$probe_id" = "all" ]; then
  echo "===DISABLED_GATEWAY_CRONS==="
  disabled_gateway_crons
fi

if selected registry; then
  echo "===REGISTRY_SNIPPETS==="
  registry_severity="ok"
  registry_code="registry_consistent"
  if [ ! -f "$health_tools_file" ] || [ ! -f "$health_registry_file" ]; then
    registry_severity="critical"
    registry_code="registry_file_missing"
  else
    callback_count=$(grep -c '\*\*Callback handlers' "$health_tools_file" 2>/dev/null || true)
    callback_record_count=$(grep -c 'cronrun_' "$health_tools_file" 2>/dev/null || true)
    gateway_heading_count=$(grep -c '^### Gateway Cron Jobs' "$health_registry_file" 2>/dev/null || true)
    system_heading_count=$(grep -c '^### System Cron Jobs' "$health_registry_file" 2>/dev/null || true)
    monitor_record_count=$(grep -F '6be7fd47-6945-4edd-ab83-49800caf9e4f' "$health_registry_file" 2>/dev/null \
      | grep -F -c '0 0,12 * * *' || true)
    if [ "$callback_count" != "1" ] || [ "$callback_record_count" -lt 1 ] \
      || [ "$gateway_heading_count" != "1" ] || [ "$system_heading_count" != "1" ] \
      || [ "$monitor_record_count" != "1" ]; then
      registry_severity="critical"
      registry_code="registry_mismatch"
    fi
  fi
  printf 'HEALTH|%s|registry|%s|bounded invariant check\n' "$registry_severity" "$registry_code"
  sed -n '/\*\*Callback handlers/,/When a `cronrun_/p' "$health_tools_file" 2>/dev/null || true
  sed -n '/### Gateway Cron Jobs/,/### System Cron Jobs/p' "$health_registry_file" 2>/dev/null || true
fi

exit 0
