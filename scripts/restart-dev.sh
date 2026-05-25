#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.dev-logs"

mkdir -p "$LOG_DIR"

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti tcp:"$port" || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping port $port (PIDs: $pids)"
    kill $pids || true
    sleep 1
    pids="$(lsof -ti tcp:"$port" || true)"
    if [[ -n "$pids" ]]; then
      echo "Force stopping port $port (PIDs: $pids)"
      kill -9 $pids || true
    fi
  else
    echo "Port $port already free"
  fi
}

echo "Bringing down old dev servers..."
stop_port 3000
stop_port 3001
stop_port 3002
stop_port 8787

echo "Starting Worker on 8787..."
nohup npm --prefix "$ROOT_DIR/worker" run dev >"$LOG_DIR/worker.log" 2>&1 &
WORKER_PID=$!

echo "Starting Frontend on 3000..."
nohup npm --prefix "$ROOT_DIR/frontend" run dev -- --port 3000 >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

sleep 2

echo ""
echo "Started:"
echo "  Worker   PID: $WORKER_PID  Log: $LOG_DIR/worker.log"
echo "  Frontend PID: $FRONTEND_PID  Log: $LOG_DIR/frontend.log"
echo ""
echo "Health checks:"
echo "  curl http://localhost:8787/auth/setup/status"
echo "  open http://localhost:3000"
