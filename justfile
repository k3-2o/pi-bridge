# pi-bridge — write → just ci → tick TODO-PLAN → commit
set shell := ["bash", "-cu"]

default: ci

setup:
    bun install

fmt:
    bunx biome check --write .

lint:
    bunx biome check .

check:
    bunx tsc --noEmit

test:
    bun test --pass-with-no-tests

ci: fmt lint check test

smoke:
    bun -e 'await import("./index.ts"); console.log("smoke: src imports clean")'

e2e:
    bun run scripts/e2e.ts

clean:
    rm -rf node_modules .pytest_cache 2>/dev/null; rm -f bun.lock 2>/dev/null; true
