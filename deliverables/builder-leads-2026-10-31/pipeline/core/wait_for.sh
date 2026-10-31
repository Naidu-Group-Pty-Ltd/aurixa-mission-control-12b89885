# wait until a log file contains DONE (avoids pgrep matching this script's own command line)
while ! grep -q '^DONE' "$1" 2>/dev/null; do sleep 20; done; tail -3 "$1"
