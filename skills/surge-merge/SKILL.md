---
name: "surge-merge"
description: >-
  Merge multiple Surge profiles into one Merged.conf with AI routing
  (process/domain rules, relay pools, chained outlets). Activate when building
  or regenerating Surge config, merging carrier subscriptions, or changing AI
  proxy routing (Claude/Codex/Grok/Gemini process rules).
---

# surge-merge

Agent-native CLI that merges Surge source profiles (carrier subscriptions) with
a typed user config (`proxies`, `relays`, `aiProfiles`, template rules) into a
single profile under `~/Library/Application Support/Surge/Profiles`.

Do **not** use this for live Surge runtime control — use the `surge` skill /
surge-cli for that. This tool only generates profile files.

## Discover Capabilities First

```bash
surge-merge @schema
surge-merge @schema .build
```

## Defaults

| Input         | Default                                                      |
| ------------- | ------------------------------------------------------------ |
| `config`      | package `config/default.ts` (credentials live here; private) |
| `profilesDir` | `~/Library/Application Support/Surge/Profiles`               |
| `output`      | from config (`Merged.conf`) relative to `profilesDir`        |
| `dryRun`      | `false`                                                      |

Sources and output always resolve under `profilesDir`, never `process.cwd()`.

## Core Workflow

```bash
# Preview without writing
surge-merge build "{ dryRun: true, verbose: true }"

# Write Merged.conf under Profiles
surge-merge build

# Alternate output filename (still under profilesDir unless absolute)
surge-merge build "{ output: 'Merged.next.conf' }"

# Custom config / profiles dir
surge-merge build "{ config: '/path/to/cfg.ts', profilesDir: '~/Library/Application Support/Surge/Profiles' }"
```

Stdout is a YAML summary (`path`, `filename`, `bytes`, `dryRun`, …). Logs go to
stderr.

## Config shape (high level)

User config is a TypeScript module default-exporting `defineConfig({...})`:

- `sources[]` — carrier profiles (facade `#!include` → `.managed/<md5>.conf`)
- `proxies` — direct proxy library for AI outlets
- `relays` — cross-source `AI-Relay-{key}` url-test pools
- `aiProfiles[]` — select groups + PROCESS-NAME / domain rules
- `topLevelGroups` — Proxy / Best / carrier aggregates
- `template` — general / dns / rulesets

Types live in `src/config.ts`. Default personal config: `config/default.ts`.

## Anti-Patterns

| Don't do this                                     | Do this instead                         | Why                                   |
| ------------------------------------------------- | --------------------------------------- | ------------------------------------- |
| `cd` into Profiles and assume relative paths work | Pass absolute/`~/` or rely on defaults  | Resolve is package/profilesDir-based  |
| Edit `Merged.conf` by hand                        | Change `config/default.ts` then `build` | Next build overwrites the merged file |
| Delete old Profiles `surge-merge/` or `build.sh`  | Leave them until cutover is confirmed   | Migration safety                      |
| Pipe full conf into agent context                 | Use dryRun summary + `diff` on disk     | Conf is large; credentials may appear |
| Use for live policy switches                      | Use `surge` skill                       | This tool only writes profile files   |

## Self-Improvement

When schema, defaults, or build semantics drift from this skill, update
`skills/surge-merge/SKILL.md` in the surge-merge repo.
