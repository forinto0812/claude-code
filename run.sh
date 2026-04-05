echo "list files in current directory" | bun run scripts/dev.ts -p  --dangerously-skip-permissions 2>/tmp/agent-debug.log; cat /tmp/agent-debug.log
