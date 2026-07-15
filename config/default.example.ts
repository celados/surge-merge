import { defineConfig } from "../src/config.ts";

// Copy this file to default.ts, then replace every placeholder locally.
// default.ts is deliberately ignored because it contains proxy credentials.
export default defineConfig({
  proxies: {
    home: {
      type: "http",
      server: "proxy.example.com",
      port: 443,
      username: "replace-me",
      password: "replace-me",
    },
  },

  sources: [
    {
      path: "carrier-profile.conf",
      prefix: "Carrier",
      includeGroups: true,
      includeRules: false,
    },
  ],

  relays: {
    JP: { include: ["日本"] },
  },

  aiProfiles: [
    {
      name: "Claude",
      direct: ["home"],
      chained: { proxies: ["home"], relayKey: "JP" },
      relayOnly: { relayKey: "JP" },
      processes: ["~/.local/share/claude/versions/*"],
      domains: ["anthropic.com", "claude.ai", "claude.com"],
    },
    {
      name: "Codex",
      direct: ["home"],
      chained: { proxies: ["home"], relayKey: "JP" },
      relayOnly: { relayKey: "JP" },
      outletOrder: ["relayOnly", "direct", "chained"],
      processes: ["/usr/local/bin/codex"],
      domains: ["openai.com", "chatgpt.com"],
    },
    {
      name: "Grok",
      direct: ["home"],
      chained: { proxies: ["home"], relayKey: "JP" },
      relayOnly: { relayKey: "JP" },
      outletOrder: ["relayOnly", "direct", "chained"],
      processes: ["~/.grok/downloads/*"],
      domains: ["x.ai", "grok.com"],
    },
  ],

  topLevelGroups: [
    {
      name: "Carrier-JP",
      type: "url-test",
      aggregate: { include: ["日本"], sources: ["Carrier"] },
      url: "http://www.gstatic.com/generate_204",
      interval: 600,
      tolerance: 50,
    },
    {
      name: "Proxy",
      type: "select",
      members: ["Carrier-JP", "Claude", "Codex", "Grok", "DIRECT"],
    },
  ],

  finalPolicy: "Proxy",
  output: "./Merged.conf",
});
