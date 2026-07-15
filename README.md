# surge-merge

Merge Surge carrier profiles with AI routing rules into one `Merged.conf`.

Agent-native CLI on [argc](https://github.com/ethan-huo/argc) + Bun. Sources and
output live under `~/Library/Application Support/Surge/Profiles`; user config
defaults to the local-only `config/default.ts` (contains credentials and is not
tracked). Bootstrap it from `config/default.example.ts`.

## Usage

```bash
bun src/main.ts @schema
bun src/main.ts build "{ dryRun: true, verbose: true }"
bun src/main.ts build
```

| Input         | Default                                        |
| ------------- | ---------------------------------------------- |
| `config`      | `config/default.ts` (package-root relative)    |
| `profilesDir` | `~/Library/Application Support/Surge/Profiles` |
| `dryRun`      | `false`                                        |
| `output`      | from config / `Merged.conf`                    |

Stdout: YAML summary (`path`, `bytes`, `dryRun`, …). Logs: stderr.

## Install

Public repo:

```bash
curl -fsSL https://raw.githubusercontent.com/celados/surge-merge/main/install.sh | bash
```

From source:

```bash
cp config/default.example.ts config/default.ts
# Edit config/default.ts and add local proxy credentials.
bun install
bun src/main.ts --help
```

## Develop

```bash
bun run check
bun run build
```

## Agent Skill

```text
skills/surge-merge/SKILL.md
```
