import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AiProfileConfig,
  OutletCategory,
  ProxyConfig,
  RelayPool,
  SourceConfig,
  UserConfig,
} from "./config.ts";

// ============================================================================
// Path resolution
// ============================================================================

function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// ============================================================================
// Constants
// ============================================================================

const BUILT_IN_POLICIES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-TINYGIF",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "CELLULAR",
  "CELLULAR-ONLY",
  "HYBRID",
]);

const DEFAULT_OUTLET_ORDER: OutletCategory[] = ["direct", "chained", "relayOnly"];

// ============================================================================
// Types
// ============================================================================

type ParsedProfile = {
  general: Map<string, string>;
  proxies: Map<string, string>;
  proxyGroups: Map<string, { type: string; members: string[]; params: string }>;
  rules: string[];
  hosts: Map<string, string>;
  urlRewrite: string[];
  headerRewrite: string[];
  mitm: Map<string, string>;
};

type ExtractedSource = {
  prefix: string;
  // prefixedName -> raw line after `=` (e.g., `AT-🇯🇵 日本 01` -> `ss, ...`)
  proxies: Map<string, string>;
  // prefixedName -> originalName (used for keyword matching without the prefix)
  originalNames: Map<string, string>;
  proxyGroups: Map<string, { type: string; members: string[]; params: string }>;
  rules: string[];
  nameMap: Map<string, string>;
};

export type BuildOptions = {
  /** Absolute profiles directory; sources and output resolve under this. */
  profilesDir: string;
  verbose?: boolean;
  log?: (msg: string) => void;
  /** Generate content only; do not write files. */
  dryRun?: boolean;
  /** Override config.output filename (relative to profilesDir unless absolute). */
  output?: string;
};

export type BuildResult = {
  main: {
    /** Output basename or relative path as configured. */
    filename: string;
    /** Absolute path where content is/would be written. */
    path: string;
    content: string;
  };
  dryRun: boolean;
};

// ============================================================================
// Parser
// ============================================================================

function parseSurgeProfile(content: string): ParsedProfile {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  const result: ParsedProfile = {
    general: new Map(),
    proxies: new Map(),
    proxyGroups: new Map(),
    rules: [],
    hosts: new Map(),
    urlRewrite: [],
    headerRewrite: [],
    mitm: new Map(),
  };

  let currentSection: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("#!")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.toLowerCase().replace(/\s+/g, "");
      continue;
    }

    if (!currentSection) continue;

    switch (currentSection) {
      case "general": {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          result.general.set(line.slice(0, eqIdx).trim(), line.slice(eqIdx + 1).trim());
        }
        break;
      }
      case "proxy": {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          const name = line.slice(0, eqIdx).trim();
          const value = line.slice(eqIdx + 1).trim();
          if (!BUILT_IN_POLICIES.has(name.toUpperCase())) {
            result.proxies.set(name, value);
          }
        }
        break;
      }
      case "proxygroup": {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          const name = line.slice(0, eqIdx).trim();
          const value = line.slice(eqIdx + 1).trim();
          const parsed = parseProxyGroup(value);
          if (parsed) result.proxyGroups.set(name, parsed);
        }
        break;
      }
      case "rule":
        result.rules.push(line);
        break;
      case "host": {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          result.hosts.set(line.slice(0, eqIdx).trim(), line.slice(eqIdx + 1).trim());
        }
        break;
      }
      case "urlrewrite":
        result.urlRewrite.push(line);
        break;
      case "headerrewrite":
        result.headerRewrite.push(line);
        break;
      case "mitm": {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          result.mitm.set(line.slice(0, eqIdx).trim(), line.slice(eqIdx + 1).trim());
        }
        break;
      }
    }
  }

  return result;
}

function parseProxyGroup(
  value: string,
): { type: string; members: string[]; params: string } | null {
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length < 1) return null;

  const type = parts[0]!.toLowerCase();
  const members: string[] = [];
  const params: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes("=")) params.push(part);
    else members.push(part);
  }

  return { type, members, params: params.join(", ") };
}

// ============================================================================
// Source path resolution (facade → .managed/)
// ============================================================================

// A "facade" source is a small Surge profile whose [Proxy]/[Proxy Group]/[Rule]
// sections only contain `#!include <URL>` directives. Surge fetches each URL
// and writes the response to `.managed/<md5(url)>.conf`. We mirror that hash
// so users can point sources at the human-readable facade file instead of the
// opaque hash path.
//
// Returns the path we should actually parse:
//   - facade with #!include URL  → `.managed/{md5(url)}.conf` (if present)
//   - anything else              → original path unchanged
async function resolveSourcePath(
  rawPath: string,
  basePath: string,
  log: (msg: string) => void,
): Promise<string> {
  const absPath = path.resolve(basePath, rawPath);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    // Don't fail here — extractSource() will surface the read error with context.
    return rawPath;
  }

  // If the file itself is a #!MANAGED-CONFIG payload, it's already the real
  // thing — read it directly.
  if (/^\s*#!MANAGED-CONFIG\b/m.test(content)) return rawPath;

  // Collect every `#!include <URL>` directive. Surge's syntax is liberal about
  // whitespace and quoting; match both `#!include foo` and `#!include "foo"`.
  const includeUrls = new Set<string>();
  for (const m of content.matchAll(/^\s*#!include\s+["']?([^\s"']+)["']?/gm)) {
    includeUrls.add(m[1]!);
  }
  if (includeUrls.size === 0) return rawPath;

  if (includeUrls.size > 1) {
    // One facade per subscription. If a file aggregates multiple URLs we can't
    // pick a single managed counterpart — bail loudly so the user notices.
    throw new Error(
      `[source] ${rawPath}: facade has ${includeUrls.size} distinct #!include URLs; ` +
        `point this source directly at the .managed/<hash>.conf file instead.`,
    );
  }

  const url = [...includeUrls][0]!;
  const hash = createHash("md5").update(url).digest("hex");
  const managedPath = `.managed/${hash}.conf`;
  const managedAbs = path.resolve(basePath, managedPath);
  try {
    await fs.access(managedAbs);
  } catch {
    log(
      `[source] ${rawPath}: facade resolves to ${managedPath} but file is missing — ` +
        `falling back to the facade itself. Open Surge once so it materializes the include.`,
    );
    return rawPath;
  }

  log(`[source] ${rawPath} → ${managedPath} (resolved via #!include md5)`);
  return managedPath;
}

// ============================================================================
// Extract proxies from source
// ============================================================================

async function extractSource(
  source: SourceConfig,
  basePath: string,
  log: (msg: string) => void,
): Promise<ExtractedSource | null> {
  const resolvedPath = await resolveSourcePath(source.path, basePath, log);
  const filePath = path.resolve(basePath, resolvedPath);

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err) {
    log(`[source] Failed to read ${source.path}: ${err}`);
    return null;
  }

  const parsed = parseSurgeProfile(content);
  const nameMap = new Map<string, string>();
  const prefixedProxies = new Map<string, string>();
  const originalNames = new Map<string, string>();
  const prefixedGroups = new Map<string, { type: string; members: string[]; params: string }>();

  for (const [name, value] of parsed.proxies) {
    const prefixedName = `${source.prefix}-${name}`;
    nameMap.set(name, prefixedName);
    prefixedProxies.set(prefixedName, value);
    originalNames.set(prefixedName, name);
  }

  if (source.includeGroups !== false) {
    for (const [name, group] of parsed.proxyGroups) {
      const prefixedName = `${source.prefix}-${name}`;
      nameMap.set(name, prefixedName);

      const rewrittenMembers = group.members.map((member) => {
        if (BUILT_IN_POLICIES.has(member.toUpperCase())) return member;
        if (nameMap.has(member)) return nameMap.get(member)!;
        return `${source.prefix}-${member}`;
      });

      prefixedGroups.set(prefixedName, {
        type: group.type,
        members: rewrittenMembers,
        params: group.params,
      });
    }
  }

  const rewrittenRules: string[] = [];
  if (source.includeRules) {
    for (const rule of parsed.rules) {
      if (rule.startsWith("FINAL,")) continue;
      rewrittenRules.push(rewriteRulePolicy(rule, nameMap, source.prefix));
    }
  }

  log(
    `[source] ${source.prefix}: ${prefixedProxies.size} proxies, ${prefixedGroups.size} groups, ${rewrittenRules.length} rules`,
  );

  return {
    prefix: source.prefix,
    proxies: prefixedProxies,
    originalNames,
    proxyGroups: prefixedGroups,
    rules: rewrittenRules,
    nameMap,
  };
}

function rewriteRulePolicy(rule: string, nameMap: Map<string, string>, prefix: string): string {
  const parts = rule.split(",");
  if (parts.length < 3) return rule;

  const policyIndex = 2;
  if (policyIndex >= parts.length) return rule;

  const policy = parts[policyIndex]!.trim();
  if (BUILT_IN_POLICIES.has(policy.toUpperCase())) return rule;

  const newPolicy = nameMap.get(policy) ?? `${prefix}-${policy}`;
  parts[policyIndex] = newPolicy;
  return parts.join(",");
}

// ============================================================================
// Render functions
// ============================================================================

function renderProxy(name: string, proxy: ProxyConfig, underlyingProxy?: string): string {
  switch (proxy.type) {
    case "snell": {
      const params = [`psk=${proxy.psk}`];
      if (proxy.version != null) params.push(`version=${proxy.version}`);
      if (proxy.reuse != null) params.push(`reuse=${proxy.reuse}`);
      if (proxy.tfo != null) params.push(`tfo=${proxy.tfo}`);
      if (underlyingProxy) params.push(`underlying-proxy=${underlyingProxy}`);
      return `${name} = snell, ${proxy.server}, ${proxy.port}, ${params.join(", ")}`;
    }
    case "ss": {
      const params = [`encrypt-method=${proxy.method}`, `password=${proxy.password}`];
      if (proxy.obfs) params.push(`obfs=${proxy.obfs}`);
      if (proxy["obfs-host"]) params.push(`obfs-host=${proxy["obfs-host"]}`);
      if (proxy.tfo != null) params.push(`tfo=${proxy.tfo}`);
      if (proxy["udp-relay"] != null) params.push(`udp-relay=${proxy["udp-relay"]}`);
      if (underlyingProxy) params.push(`underlying-proxy=${underlyingProxy}`);
      return `${name} = ss, ${proxy.server}, ${proxy.port}, ${params.join(", ")}`;
    }
    case "vmess": {
      let line = `${name} = vmess, ${proxy.server}, ${proxy.port}, username=${proxy.uuid}`;
      if (underlyingProxy) line += `, underlying-proxy=${underlyingProxy}`;
      return line;
    }
    case "http": {
      const params: string[] = [];
      if (proxy.username) params.push(proxy.username);
      if (proxy.password) params.push(proxy.password);
      if (proxy.tls != null) params.push(`tls=${proxy.tls}`);
      if (proxy["skip-cert-verify"] != null)
        params.push(`skip-cert-verify=${proxy["skip-cert-verify"]}`);
      if (proxy.sni) params.push(`sni=${proxy.sni}`);
      if (underlyingProxy) params.push(`underlying-proxy=${underlyingProxy}`);
      const paramsStr = params.length > 0 ? `, ${params.join(", ")}` : "";
      return `${name} = http, ${proxy.server}, ${proxy.port}${paramsStr}`;
    }
  }
}

function renderRuleLine(
  prefix: "DOMAIN-KEYWORD" | "DOMAIN" | "DOMAIN-SUFFIX",
  value: string,
  policy: string,
): string {
  return `${prefix},${value},${policy}`;
}

function renderDomainRule(domain: string, policy: string): string {
  if (domain.startsWith("keyword:"))
    return renderRuleLine("DOMAIN-KEYWORD", domain.slice(8), policy);
  if (domain.startsWith("domain:")) return renderRuleLine("DOMAIN", domain.slice(7), policy);
  if (domain.startsWith("suffix:")) return renderRuleLine("DOMAIN-SUFFIX", domain.slice(7), policy);
  return renderRuleLine("DOMAIN-SUFFIX", domain, policy);
}

// ============================================================================
// Relay pool & outlet expansion
// ============================================================================

function filterRelayMembers(source: ExtractedSource, pool: RelayPool): string[] {
  const members: string[] = [];
  for (const prefixedName of source.proxies.keys()) {
    const original = source.originalNames.get(prefixedName) ?? prefixedName;
    const passInclude =
      pool.include.length === 0 || pool.include.some((kw) => original.includes(kw));
    if (!passInclude) continue;
    if (pool.exclude?.some((kw) => original.includes(kw))) continue;
    members.push(prefixedName);
  }
  return members;
}

type RelayGroup = {
  name: string; // e.g., "AI-Relay-JP"
  relayKey: string;
  members: string[]; // prefixed node names from any of the contributing sources
};

function relayGroupName(relayKey: string): string {
  return `AI-Relay-${relayKey}`;
}

function buildRelayGroups(
  config: UserConfig,
  sources: ExtractedSource[],
  log: (msg: string) => void,
): RelayGroup[] {
  const sourceByPrefix = new Map(sources.map((s) => [s.prefix, s]));
  const groups: RelayGroup[] = [];

  for (const [relayKey, pool] of Object.entries(config.relays ?? {})) {
    const wantedPrefixes = pool.sources ?? sources.map((s) => s.prefix);
    const members: string[] = [];
    for (const prefix of wantedPrefixes) {
      const source = sourceByPrefix.get(prefix);
      if (!source) {
        log(`[relay] ${relayGroupName(relayKey)}: unknown source prefix "${prefix}" — skipping`);
        continue;
      }
      members.push(...filterRelayMembers(source, pool));
    }
    const name = relayGroupName(relayKey);
    if (members.length === 0) {
      log(`[relay] ${name} is empty (no members match) — skipping`);
      continue;
    }
    groups.push({ name, relayKey, members });
  }
  return groups;
}

function resolveTopLevelMembers(
  group: { name: string; members?: string[]; aggregate?: RelayPool },
  sources: ExtractedSource[],
  log: (msg: string) => void,
): string[] {
  if (group.members && group.aggregate) {
    throw new Error(
      `Top-level group "${group.name}": specify either "members" or "aggregate", not both`,
    );
  }
  if (group.members) return group.members;
  if (group.aggregate) {
    const pool = group.aggregate;
    const sourceByPrefix = new Map(sources.map((s) => [s.prefix, s]));
    const wantedPrefixes = pool.sources ?? sources.map((s) => s.prefix);
    const members: string[] = [];
    for (const prefix of wantedPrefixes) {
      const source = sourceByPrefix.get(prefix);
      if (!source) {
        log(`[group] "${group.name}": unknown source prefix "${prefix}" — skipping`);
        continue;
      }
      members.push(...filterRelayMembers(source, pool));
    }
    return members;
  }
  throw new Error(`Top-level group "${group.name}": must specify "members" or "aggregate"`);
}

type ResolvedOutlet =
  | { kind: "direct"; outletName: string; proxyKey: string }
  | { kind: "chained"; outletName: string; proxyKey: string; relayGroupName: string }
  | { kind: "relayOnly"; outletName: string; relayGroupName: string };

function resolveOutlets(
  profile: AiProfileConfig,
  relayGroupIndex: Map<string, RelayGroup>, // key: relayKey
  log: (msg: string) => void,
): ResolvedOutlet[] {
  const order = profile.outletOrder ?? DEFAULT_OUTLET_ORDER;
  const byCategory: Record<OutletCategory, ResolvedOutlet[]> = {
    direct: [],
    chained: [],
    relayOnly: [],
  };

  if (profile.direct?.length) {
    for (const proxyKey of profile.direct) {
      byCategory.direct.push({ kind: "direct", outletName: proxyKey, proxyKey });
    }
  }

  if (profile.chained) {
    const { proxies, relayKey } = profile.chained;
    if (!relayGroupIndex.has(relayKey)) {
      log(
        `[outlet] profile "${profile.name}" references missing relay "${relayKey}" (chained) — skipping`,
      );
    } else {
      const name = relayGroupName(relayKey);
      for (const proxyKey of proxies) {
        byCategory.chained.push({
          kind: "chained",
          outletName: `${proxyKey}-via-${relayKey}`,
          proxyKey,
          relayGroupName: name,
        });
      }
    }
  }

  if (profile.relayOnly) {
    const { relayKey } = profile.relayOnly;
    if (!relayGroupIndex.has(relayKey)) {
      log(
        `[outlet] profile "${profile.name}" references missing relay "${relayKey}" (relayOnly) — skipping`,
      );
    } else {
      const name = relayGroupName(relayKey);
      byCategory.relayOnly.push({ kind: "relayOnly", outletName: name, relayGroupName: name });
    }
  }

  return order.flatMap((cat) => byCategory[cat]);
}

// ============================================================================
// Main build
// ============================================================================

type BuildContext = {
  config: UserConfig;
  sources: ExtractedSource[];
  log: (msg: string) => void;
};

function generateConfig(ctx: BuildContext): string {
  const { config, sources, log } = ctx;
  const sections: string[] = [];

  // ---- Resolve relay groups and outlets up front ----
  const relayGroups = buildRelayGroups(config, sources, log);
  const relayGroupIndex = new Map<string, RelayGroup>();
  for (const g of relayGroups) {
    relayGroupIndex.set(g.relayKey, g);
  }

  const profiles = config.aiProfiles ?? [];
  const profileOutlets = new Map<string, ResolvedOutlet[]>();
  for (const profile of profiles) {
    profileOutlets.set(profile.name, resolveOutlets(profile, relayGroupIndex, log));
  }

  // Collect direct proxy definitions and unique chained definitions needed.
  const directProxiesNeeded = new Set<string>();
  // chainedKey = `{proxyKey}|{relayGroupName}` -> ensure only one definition
  const chainedDefinitions = new Map<
    string,
    { proxyKey: string; relayGroupName: string; outletName: string }
  >();
  for (const outlets of profileOutlets.values()) {
    for (const o of outlets) {
      if (o.kind === "direct") directProxiesNeeded.add(o.proxyKey);
      if (o.kind === "chained") {
        directProxiesNeeded.add(o.proxyKey); // chained proxies reuse direct proxy spec
        chainedDefinitions.set(`${o.outletName}`, {
          proxyKey: o.proxyKey,
          relayGroupName: o.relayGroupName,
          outletName: o.outletName,
        });
      }
    }
  }

  // ---- [General] ----
  sections.push("[General]");
  // Map keeps general's insertion order; the dns block then overrides the
  // resolver keys in place (single source of truth, no duplicate lines).
  const generalEntries = new Map<string, string | number | boolean>(
    Object.entries(config.template?.general ?? {}),
  );
  const dns = config.template?.dns;
  if (dns?.server?.length) generalEntries.set("dns-server", dns.server.join(", "));
  if (dns?.encryptedServer?.length)
    generalEntries.set("encrypted-dns-server", dns.encryptedServer.join(", "));
  if (generalEntries.size > 0) {
    for (const [key, value] of generalEntries) {
      sections.push(`${key} = ${value}`);
    }
  } else {
    sections.push("loglevel = notify");
  }
  sections.push("");

  // ---- [Proxy] ----
  sections.push("[Proxy]");

  if (directProxiesNeeded.size > 0) {
    sections.push(`# === Direct AI Proxies ===`);
    for (const key of directProxiesNeeded) {
      const def = config.proxies?.[key];
      if (!def) {
        throw new Error(
          `AI profile references unknown proxy "${key}" — define it in top-level proxies`,
        );
      }
      sections.push(renderProxy(key, def));
    }
    sections.push("");
  }

  if (chainedDefinitions.size > 0) {
    sections.push(`# === Chained AI Proxies ===`);
    for (const { proxyKey, relayGroupName, outletName } of chainedDefinitions.values()) {
      const def = config.proxies![proxyKey]!;
      sections.push(renderProxy(outletName, def, relayGroupName));
    }
    sections.push("");
  }

  for (const source of sources) {
    sections.push(`# === ${source.prefix} Proxies ===`);
    for (const [name, value] of source.proxies) {
      sections.push(`${name} = ${value}`);
    }
    sections.push("");
  }

  // ---- [Proxy Group] ----
  sections.push("[Proxy Group]");

  if (relayGroups.length > 0) {
    sections.push(`# === Relay Groups (aggregated by region across sources) ===`);
    for (const g of relayGroups) {
      sections.push(
        `${g.name} = url-test, ${g.members.join(", ")}, url=http://www.gstatic.com/generate_204, interval=600, tolerance=50`,
      );
    }
    sections.push("");
  }

  if (profiles.length > 0) {
    sections.push(`# === AI Profile Groups ===`);
    for (const profile of profiles) {
      const outlets = profileOutlets.get(profile.name)!;
      if (outlets.length === 0) {
        log(`[profile] "${profile.name}" has no outlets — skipping`);
        continue;
      }
      const memberNames = outlets.map((o) => o.outletName);
      if (profile.members?.length) memberNames.push(...profile.members);
      sections.push(`${profile.name} = select, ${memberNames.join(", ")}`);
    }
    sections.push("");
  }

  if (config.topLevelGroups?.length) {
    sections.push(`# === Top Level Groups ===`);
    for (const group of config.topLevelGroups) {
      const members = resolveTopLevelMembers(group, sources, log);
      if (members.length === 0) {
        log(`[group] "${group.name}" resolved to 0 members — skipping`);
        continue;
      }
      let line = `${group.name} = ${group.type}, ${members.join(", ")}`;
      if (group.url) line += `, url=${group.url}`;
      if (group.interval) line += `, interval=${group.interval}`;
      if (group.tolerance) line += `, tolerance=${group.tolerance}`;
      sections.push(line);
    }
    sections.push("");
  }

  // Collect names already claimed by relay / AI-profile / top-level groups so
  // source groups with the same name are silently dropped (our definitions win).
  const definedGroupNames = new Set<string>();
  for (const g of relayGroups) definedGroupNames.add(g.name);
  for (const p of profiles) definedGroupNames.add(p.name);
  for (const g of config.topLevelGroups ?? []) definedGroupNames.add(g.name);

  for (const source of sources) {
    if (source.proxyGroups.size > 0) {
      sections.push(`# === ${source.prefix} Groups ===`);
      for (const [name, group] of source.proxyGroups) {
        if (definedGroupNames.has(name)) continue;
        let line = `${name} = ${group.type}, ${group.members.join(", ")}`;
        if (group.params) line += `, ${group.params}`;
        sections.push(line);
      }
      sections.push("");
    }
  }

  // ---- [Rule] ----
  sections.push("[Rule]");

  // Bypass first — domestic AI endpoints must escape any catch-all PROCESS rule below.
  if (config.bypassDomains?.length) {
    sections.push(`# === AI Bypass Domains (DIRECT) ===`);
    for (const domain of config.bypassDomains) {
      if (domain) sections.push(renderDomainRule(domain, "DIRECT"));
    }
    sections.push("");
  }

  // Per-profile process rules, grouped per profile so each profile is independent.
  for (const profile of profiles) {
    if (!profile.processes?.length) continue;
    sections.push(`# === ${profile.name} Process Rules ===`);
    for (const proc of profile.processes) {
      if (proc) sections.push(`PROCESS-NAME,${resolvePath(proc)},${profile.name}`);
    }
    sections.push("");
  }

  // Per-profile domain rules.
  for (const profile of profiles) {
    if (!profile.domains?.length) continue;
    sections.push(`# === ${profile.name} Domain Rules ===`);
    for (const domain of profile.domains) {
      if (domain) sections.push(renderDomainRule(domain, profile.name));
    }
    sections.push("");
  }

  for (const source of sources) {
    if (source.rules.length > 0) {
      sections.push(`# === ${source.prefix} Rules ===`);
      for (const rule of source.rules) sections.push(rule);
      sections.push("");
    }
  }

  if (config.template?.rules?.length) {
    sections.push(`# === Custom Rules ===`);
    for (const rule of config.template.rules) sections.push(rule);
  }

  const finalPolicy = config.finalPolicy ?? config.topLevelGroups?.[0]?.name ?? "DIRECT";
  sections.push(`FINAL,${finalPolicy}`);
  sections.push("");

  // ---- [Host] ----
  if (config.template?.hosts && Object.keys(config.template.hosts).length > 0) {
    sections.push("[Host]");
    for (const [host, ip] of Object.entries(config.template.hosts)) {
      sections.push(`${host} = ${ip}`);
    }
    sections.push("");
  }

  // ---- [URL Rewrite] ----
  if (config.template?.urlRewrite?.length) {
    sections.push("[URL Rewrite]");
    for (const rule of config.template.urlRewrite) sections.push(rule);
    sections.push("");
  }

  // ---- [Header Rewrite] ----
  if (config.template?.headerRewrite?.length) {
    sections.push("[Header Rewrite]");
    for (const rule of config.template.headerRewrite) sections.push(rule);
    sections.push("");
  }

  // ---- [MITM] ----
  if (config.template?.mitm) {
    sections.push("[MITM]");
    const mitm = config.template.mitm;
    if (mitm.enable != null) sections.push(`enable = ${mitm.enable}`);
    if (mitm["tcp-connection"] != null) sections.push(`tcp-connection = ${mitm["tcp-connection"]}`);
    if (mitm["skip-server-cert-verify"] != null) {
      sections.push(`skip-server-cert-verify = ${mitm["skip-server-cert-verify"]}`);
    }
    if (mitm.hostname?.length) sections.push(`hostname = ${mitm.hostname.join(", ")}`);
    sections.push("");
  }

  return sections.join("\n");
}

export async function build(config: UserConfig, options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? ((msg: string) => console.error(msg));
  const vlog = (msg: string) => {
    if (options.verbose) log(msg);
  };

  // sources / output always resolve under profilesDir, never process.cwd()
  const profilesDir = options.profilesDir;

  const sources: ExtractedSource[] = [];
  for (const source of config.sources) {
    const extracted = await extractSource(source, profilesDir, vlog);
    if (extracted) sources.push(extracted);
  }

  const ctx: BuildContext = { config, sources, log: vlog };
  const filename = options.output ?? config.output ?? "Merged.conf";
  const absPath = path.isAbsolute(resolvePath(filename))
    ? resolvePath(filename)
    : path.resolve(profilesDir, filename);
  const mainContent = generateConfig(ctx);
  const dryRun = options.dryRun === true;

  log(`[build] Generated ${absPath}${dryRun ? " (dryRun)" : ""}`);

  return {
    main: { filename, path: absPath, content: mainContent },
    dryRun,
  };
}

// ============================================================================
// Write output
// ============================================================================

export async function writeOutput(content: string, outputPath: string): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");
}

/** Write build outputs to absolute paths on result.main.path. No-op when dryRun. */
export async function writeAllOutputs(
  result: BuildResult,
  log?: (msg: string) => void,
): Promise<void> {
  const logger = log ?? ((msg: string) => console.error(msg));
  if (result.dryRun) {
    logger(`[write] dryRun — skipped ${result.main.path}`);
    return;
  }
  await writeOutput(result.main.content, result.main.path);
  logger(`[write] ${result.main.path}`);
}
