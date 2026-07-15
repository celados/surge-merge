// ============================================================================
// Proxy definitions
// ============================================================================

export type SnellProxy = {
  type: "snell";
  server: string;
  port: number;
  psk: string;
  version?: number;
  reuse?: boolean;
  tfo?: boolean;
};

export type SsProxy = {
  type: "ss";
  server: string;
  port: number;
  method: string;
  password: string;
  obfs?: string;
  "obfs-host"?: string;
  tfo?: boolean;
  "udp-relay"?: boolean;
};

export type VmessProxy = {
  type: "vmess";
  server: string;
  port: number;
  uuid: string;
};

export type HttpProxy = {
  type: "http";
  server: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
  "skip-cert-verify"?: boolean;
  sni?: string;
};

export type ProxyConfig = SnellProxy | SsProxy | VmessProxy | HttpProxy;

// ============================================================================
// Source configuration (profiles to extract proxies from)
// ============================================================================

export type RelayPool = {
  // Keyword match on proxy name. A node is included if ANY keyword in `include`
  // appears in its name. Use this to slice across sources by region.
  include: string[];
  // Optional exclusion (applied after include): drop nodes whose name contains
  // ANY of these keywords. Useful to skip e.g. trial/expiry placeholder entries.
  exclude?: string[];
  // Restrict collection to these source prefixes. Default: every source.
  // Useful if some carrier's nodes are unreliable in a specific region.
  sources?: string[];
};

export type SourceConfig = {
  // Path to the profile (relative to profilesDir)
  path: string;
  // Prefix for proxy/group names (e.g., "AT", "YT", "CD")
  prefix: string;
  // Whether to include this source's proxy groups (default: true)
  includeGroups?: boolean;
  // Whether to include this source's rules with policy name rewriting (default: false)
  includeRules?: boolean;
};

// ============================================================================
// AI Profile configuration
// ============================================================================

export type OutletCategory = "direct" | "chained" | "relayOnly";

export type AiProfileConfig = {
  // Surge `select` group name. Becomes the policy referenced by this profile's
  // process/domain rules.
  name: string;
  // Direct outlets: keys from the top-level `proxies` map. Rendered verbatim.
  direct?: string[];
  // Chained outlets: for each proxy, one `{proxy}-via-{relayKey}` outlet whose
  // underlying-proxy points to the global `AI-Relay-{relayKey}` group. The relay
  // pool aggregates across sources (see top-level `relays`), so there is one
  // chained outlet per (proxy × relayKey), NOT per source.
  chained?: {
    proxies: string[];
    relayKey: string;
  };
  // Relay-only outlet: a single member referencing `AI-Relay-{relayKey}`.
  relayOnly?: {
    relayKey: string;
  };
  // Extra members appended to the select group (e.g., per-carrier relay groups
  // like "AT-JP" for manual carrier pinning within an AI profile).
  members?: string[];
  // Concatenation order of outlet categories in the select group. The first
  // outlet becomes the default selection in Surge UI, so flip this to bias
  // a profile toward e.g. relay-only by default.
  outletOrder?: OutletCategory[];
  // Process names/paths to route through this profile (Mac only).
  // Supports plain name, full path, or path with wildcards; `~/` resolves at build.
  processes?: string[];
  // Domains to route through this profile.
  // Prefixed forms: `keyword:foo`, `domain:foo`, `suffix:foo` (default: suffix).
  domains?: string[];
};

// ============================================================================
// Template configuration (user-maintained sections)
// ============================================================================

export type TemplateConfig = {
  general?: Record<string, string | number | boolean>;
  // DNS resolution. Surge resolves a hostname BEFORE handing traffic to any
  // proxy, so a broken resolver kills a single domain on EVERY exit — switching
  // carriers can't fix what fails before the tunnel. Canonical source for the
  // resolver keys: overrides any dns-server / encrypted-dns-server left in
  // `general`, and joins arrays with ", ".
  dns?: {
    // `dns-server`. Plain UDP/TCP resolvers. Avoid "system": the local router
    // may return an empty answer for some domains (observed: .md ccTLD), leaving
    // Surge with no IP — the connection then resets locally in ~20ms.
    server?: string[];
    // `encrypted-dns-server`. DoH/DoT endpoints, tried first. Preferred — it
    // bypasses local router / ISP resolver poisoning entirely.
    encryptedServer?: string[];
  };
  rules?: string[];
  hosts?: Record<string, string>;
  urlRewrite?: string[];
  headerRewrite?: string[];
  mitm?: {
    enable?: boolean;
    "tcp-connection"?: boolean;
    "skip-server-cert-verify"?: boolean;
    hostname?: string[];
  };
};

// ============================================================================
// Top-level group configuration
// ============================================================================

export type TopLevelGroupConfig = {
  name: string;
  type: "select" | "url-test" | "fallback" | "load-balance" | "smart";
  // Explicit member list. Use this OR `aggregate` (exactly one).
  members?: string[];
  // Cross-source node collection — same filter semantics as RelayPool. The
  // build aggregates matching nodes from every (or specified) source and uses
  // them as this group's members. Lets a single url-test pick the best node
  // across carriers automatically; replaces the manual carrier-swap workflow.
  aggregate?: RelayPool;
  url?: string;
  interval?: number;
  tolerance?: number;
};

// ============================================================================
// Main configuration
// ============================================================================

export type UserConfig = {
  // Direct proxy library shared by AI profiles. Keys are the names you reference
  // from `aiProfiles[].direct` / `chained.proxies`. Definitions are emitted once.
  proxies?: Record<string, ProxyConfig>;

  // Source profiles to extract proxies from
  sources: SourceConfig[];

  // Global relay pools — named groups that aggregate matching nodes ACROSS
  // sources. Each entry produces one `AI-Relay-{key}` url-test group; node
  // names keep their source prefix (e.g. `AT-...`, `YT-...`) so you can still
  // see which carrier each member belongs to. Replaces the older per-source
  // `{prefix}-Relay-{key}` design — one region, one pool, no manual carrier
  // swapping in Surge UI.
  relays?: Record<string, RelayPool>;

  // AI profiles. Each profile becomes one `select` group plus its own
  // process/domain rules. Profiles are fully independent — different processes
  // and domains route through different outlets.
  aiProfiles?: AiProfileConfig[];

  // Domains that should bypass ALL AI profiles and go DIRECT. Rendered before
  // process rules so domestic AI gateways are not captured by PROCESS-NAME catch-alls.
  bypassDomains?: string[];

  // Top-level proxy groups (your own groups that reference profile / source groups)
  topLevelGroups?: TopLevelGroupConfig[];

  // FINAL rule policy (default: first top-level group or "DIRECT")
  finalPolicy?: string;

  // Template for user-maintained sections
  template?: TemplateConfig;

  // Output filename relative to profilesDir (default: "Merged.conf")
  output?: string;
};

export function defineConfig(config: UserConfig): UserConfig {
  return config;
}
