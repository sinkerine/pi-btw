# pi-btw

Standalone Pi extension. Keep parent model context isolated. Preserve ordered provider request prefixes and tool declarations; a rebuilt transcript is not equivalent to the captured request. Read `docs/context-and-cache.md` before changing the worker, boundary or persistence.

## Checks

```sh
npm ci
npm run typecheck
npm run lint
npx vitest run tests/unit --bail=1
PI_BINARY=pi npx vitest run tests/integration/prefix.integration.test.ts --bail=1
PI_BINARY=pi npx vitest run tests/integration/rpc.integration.test.ts --maxWorkers=1 --bail=1
npm run format:files -- <changed files>
```

Use npm scripts for formatting/lint. On NixOS, the npm Biome distribution may need the existing system dynamic loader; provide `BIOME_BINARY` pointing at a local ignored wrapper rather than changing system configuration. Run only the relevant suite. In a shared Paseo feature run, acquire its existing build lock once around the actual check command; release on exit. Never hold an idle lock while editing or reasoning.

Integration tests run real Pi **1.4.0** with a local capturing HTTP fixture and disposable agent directories. They never use the user's main daemon or live Pi config. Set `BTW_REPORT_DIR` for per-API JSON evidence. Preserve exact-prefix failures and compare final provider payloads. Anthropic movable cache markers may move at the suffix; don't normalize message shapes or tool declarations to conceal divergence.

Live measurements use `node scripts/measure-cache.mjs --out <artifact path>`, synthetic public context, isolated config/auth copies, and exact baseline provenance. No auth precheck, conditional skip, npm publication, global install or live configuration modification. Treat unavailable counters and platform evidence as unknown. Do not print credentials.

Host contract v1 lives in `src/contract.ts` and `docs/host-contract.md`. Never parse terminal answers as host events. Keep the extension useful without Paseo.
