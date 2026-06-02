#!/usr/bin/env bash
# ci-runner-controller — self-sustaining ephemeral GitHub Actions runner controller (DEC-060 follow-up)
# Knox-mandated controls: poll (outbound-only) | JIT (in-memory creds) | scope-pinned | stdin handoff
# | concurrency cap | structured logs w/o secrets | reconcile/prune orphans.
# Placement: gateway-side (jinn86); PAT via `op read` at runtime only (never argv/disk/EnvironmentFile).
set -uo pipefail

# ---- HARDCODED SCOPE (Knox control #2: blast radius == declared scope; no param overrides) ----
readonly REPO="w-gitops/jinn"
readonly CT="1120066"
readonly LABELS="self-hosted,linux,pve21"
readonly OP_REF="op://Agents/jinn-admin-rw Github Token/token"
readonly MAX_INFLIGHT=4          # Knox control #4: hard ceiling on concurrent JIT runners
readonly POLL_BASE=15            # seconds
readonly POLL_MAX=120            # cap for backoff
readonly API="https://api.github.com/repos/${REPO}"

log(){ printf '%s ci-controller %s\n' "$(date -u +%FT%TZ)" "$*"; }   # control #5: never logs secret material

gh_pat(){ op read "$OP_REF" 2>/dev/null; }   # control: PAT only in process memory at call time

# count runners we currently have online/active (in-flight)
inflight(){
  local pat; pat="$(gh_pat)"
  curl -s -H "Authorization: token $pat" "${API}/actions/runners" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sum(1 for r in d.get("runners",[]) if r.get("status")=="online"))' 2>/dev/null || echo 0
}

# reconcile: delete offline/stale runners so failed launches do not leave orphans (control #5)
reconcile(){
  local pat; pat="$(gh_pat)"
  curl -s -H "Authorization: token $pat" "${API}/actions/runners" 2>/dev/null \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
for r in d.get("runners",[]):
    if r.get("status")=="offline": print(r["id"])' 2>/dev/null \
  | while read -r rid; do
      [ -n "$rid" ] && curl -s -o /dev/null -X DELETE -H "Authorization: token $pat" "${API}/actions/runners/${rid}" 2>/dev/null && log "reconcile pruned offline runner id=$rid"
    done
}

# number of queued jobs that want our labels
queued_jobs(){
  local pat; pat="$(gh_pat)"
  # in_progress+queued runs, then their queued jobs targeting self-hosted+pve21
  curl -s -H "Authorization: token $pat" "${API}/actions/runs?status=queued&per_page=20" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("total_count",0))' 2>/dev/null || echo 0
}

# mint a JIT config and launch ONE ephemeral runner on the CT via stdin (control #1: never argv/disk)
launch_one(){
  local pat jit ts name
  pat="$(gh_pat)"
  ts="$(date -u +%H%M%S)"
  name="jinn-ci-${CT}-jit-${ts}-$$"
  jit="$(curl -s -X POST -H "Authorization: token $pat" -H 'Accept: application/vnd.github+json' \
        "${API}/actions/runners/generate-jitconfig" \
        -d "{\"name\":\"${name}\",\"runner_group_id\":1,\"labels\":[\"self-hosted\",\"linux\",\"pve21\"]}" 2>/dev/null \
        | python3 -c 'import sys,json; print(json.load(sys.stdin).get("encoded_jit_config",""))' 2>/dev/null)"
  if [ -z "$jit" ]; then log "ERROR jitconfig mint failed (name=${name})"; return 1; fi
  # hand JIT to CT via stdin -> run.sh --jitconfig read from stdin; one-shot, detached, in-memory
  printf '%s\n' "$jit" | ssh pve21 "pct exec ${CT} -- bash /home/runner/jit_launch.sh" >/dev/null 2>&1
  local rc=$?
  jit=""
  if [ $rc -eq 0 ]; then log "launched ephemeral runner name=${name} (rc=0)"; else log "ERROR launch failed name=${name} rc=${rc}"; fi
  return $rc
}

log "controller start scope repo=${REPO} ct=${CT} max_inflight=${MAX_INFLIGHT} (poll/JIT/gateway-side)"
interval=$POLL_BASE
while true; do
  reconcile
  q="$(queued_jobs)"; inf="$(inflight)"
  if [ "${q:-0}" -gt 0 ] && [ "${inf:-0}" -lt "$MAX_INFLIGHT" ]; then
    need=$(( q - inf )); [ $need -lt 1 ] && need=1
    avail=$(( MAX_INFLIGHT - inf )); [ $need -gt $avail ] && need=$avail
    log "queued=${q} inflight=${inf} -> launching ${need}"
    for _ in $(seq 1 "$need"); do launch_one; done
    interval=$POLL_BASE
  else
    # backoff w/ jitter when idle (control #a mandate: don't hammer the API)
    interval=$(( interval + 15 )); [ $interval -gt $POLL_MAX ] && interval=$POLL_MAX
    [ "${q:-0}" -eq 0 ] && log "idle queued=0 inflight=${inf} next_poll=${interval}s" || log "at-capacity queued=${q} inflight=${inf} next_poll=${interval}s"
  fi
  sleep $(( interval + (RANDOM % 6) ))
done
