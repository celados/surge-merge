#!/usr/bin/env bun

import { pathToFileURL } from "node:url";

import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { c, cli } from "argc";
import * as v from "valibot";

import packageJson from "../package.json" with { type: "json" };
import { build, writeAllOutputs } from "./build.ts";
import type { UserConfig } from "./config.ts";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_PROFILES_DIR,
  resolveConfigPath,
  resolveProfilesDir,
} from "./paths.ts";

const s = toStandardJsonSchema;

const schema = {
  build: c
    .meta({
      description: "Build a merged Surge profile with AI routing rules",
      examples: [
        "surge-merge build",
        'surge-merge build "{ dryRun: true, verbose: true }"',
        "surge-merge build \"{ output: 'Merged.next.conf' }\"",
      ],
    })
    .input(
      s(
        v.object({
          config: v.optional(
            v.pipe(
              v.string(),
              v.description(
                `Config module path (default: package config/default.ts → ${DEFAULT_CONFIG_PATH})`,
              ),
            ),
          ),
          profilesDir: v.optional(
            v.pipe(
              v.string(),
              v.description(`Surge Profiles directory (default: ${DEFAULT_PROFILES_DIR})`),
            ),
          ),
          verbose: v.optional(v.pipe(v.boolean(), v.description("Verbose logs on stderr")), false),
          dryRun: v.optional(
            v.pipe(v.boolean(), v.description("Generate content without writing files")),
            false,
          ),
          output: v.optional(
            v.pipe(
              v.string(),
              v.description(
                "Output path relative to profilesDir (or absolute); overrides config.output",
              ),
            ),
          ),
        }),
      ),
    ),
};

const app = cli(schema, {
  name: "surge-merge",
  version: packageJson.version,
  description: "Merge Surge profiles with AI routing rules",
});

await app.run({
  handlers: {
    build: async ({ input }) => {
      const configPath = resolveConfigPath(input.config);
      const profilesDir = resolveProfilesDir(input.profilesDir);
      const log = (msg: string) => console.error(msg);

      const configUrl = pathToFileURL(configPath).href;
      let config: UserConfig;
      try {
        const mod = (await import(configUrl)) as {
          default?: UserConfig;
        };
        if (!mod.default) {
          throw new Error(`Config module has no default export: ${configPath}`);
        }
        config = mod.default;
      } catch (err) {
        // Let argc serialize the error; do not process.exit.
        throw new Error(`Failed to load config ${configPath}: ${err}`);
      }

      log(`[config] Loaded ${configPath}`);
      log(`[config] profilesDir=${profilesDir}`);

      const result = await build(config, {
        profilesDir,
        verbose: input.verbose,
        dryRun: input.dryRun,
        output: input.output,
        log,
      });

      await writeAllOutputs(result, log);

      const bytes = Buffer.byteLength(result.main.content, "utf8");
      return {
        path: result.main.path,
        filename: result.main.filename,
        bytes,
        dryRun: result.dryRun,
        profilesDir,
        config: configPath,
      };
    },
  },
});
