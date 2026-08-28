/**
 * Single source of truth for the opencode sandbox.
 *
 * Verified against opencode v1.14.41 (`~/.opencode/bin/opencode`):
 *
 *  1. The websearch tool is gated by, verbatim from the bundle:
 *       ToolRegistry.tools -> filter(U => {
 *         if (U.id === Ra.id) return V.providerID === Is.opencode || ee.OPENCODE_ENABLE_EXA;
 *         ...
 *       })
 *     and `Ra = Co("websearch", ...)`. So `websearch` is only offered to models whose
 *     providerID is "opencode" (the free zen models), unless OPENCODE_ENABLE_EXA is set.
 *
 *  2. Permission resolution is `findLast(rule => match(key, rule))` over the ruleset, and the
 *     ruleset is built by iterating Object.entries() in INSERTION ORDER. Therefore "*" must be
 *     the FIRST key and any allow-entries must be LAST. See assertPolicyOrder() below, and
 *     test/opencode/policy.test.ts. If this order is ever broken the policy silently inverts.
 *
 *  3. Unmatched permission keys default to "allow". `external_directory` and `doom_loop`
 *     default to "ask". An unanswered "ask" in headless serve mode blocks forever
 *     (Deferred.await with no timeout), so both are pinned to "deny" explicitly.
 *
 *  4. The per-request `tools` map REPLACES session.permission wholesale rather than merging:
 *       for (const [k, v] of Object.entries(body.tools ?? {}))
 *         rules.push({ permission: k, action: v ? "allow" : "deny", pattern: "*" })
 *       if (rules.length > 0) session.permission = rules
 *     so we always send a complete map, never a delta.
 */

/** Every tool id opencode is known to register, from the bundle's own list plus observed ids. */
export const KNOWN_TOOL_IDS = [
  "bash", "read", "write", "edit", "patch", "apply_patch",
  "glob", "grep", "list", "webfetch", "websearch",
  "task", "skill", "todowrite", "todoread", "lsp", "question",
] as const;

/** Non-tool permission keys that still gate execution and can raise a blocking prompt. */
export const NON_TOOL_PERMISSION_KEYS = ["external_directory", "doom_loop"] as const;

export type ToolPolicy = "none" | "research";

/** The only tools a "research" policy may use. Everything else is a violation. */
export const RESEARCH_TOOLS = ["websearch", "webfetch"] as const;

export type PermissionAction = "allow" | "deny";
export type PermissionMap = Record<string, PermissionAction>;

/**
 * Build a permission map with "*": "deny" first and the named allows last.
 * Order is load-bearing - see note 2 above.
 */
function denyAllExcept(allow: readonly string[]): PermissionMap {
  const map: PermissionMap = {};
  map["*"] = "deny";
  // Enumerate explicitly even though "*" covers them. Costs nothing, and the policy still
  // holds if wildcard matching semantics ever change.
  for (const id of KNOWN_TOOL_IDS) {
    if (!allow.includes(id)) map[id] = "deny";
  }
  for (const key of NON_TOOL_PERMISSION_KEYS) map[key] = "deny";
  // Allows LAST so findLast() resolves to them.
  for (const id of allow) map[id] = "allow";
  return map;
}

/**
 * Throws if a permission map could resolve the wrong way. Called at boot and in tests, so a
 * refactor or a JSON round-trip that reorders keys fails loudly instead of silently granting.
 */
export function assertPolicyOrder(map: PermissionMap, label: string): void {
  const keys = Object.keys(map);
  if (keys[0] !== "*") {
    throw new Error(`[policy:${label}] "*" must be the first key, got "${keys[0]}"`);
  }
  if (map["*"] !== "deny") {
    throw new Error(`[policy:${label}] "*" must be "deny", got "${map["*"]}"`);
  }
  const firstAllow = keys.findIndex((k) => map[k] === "allow");
  if (firstAllow !== -1) {
    const lastDeny = keys.map((k) => map[k]).lastIndexOf("deny");
    if (lastDeny > firstAllow) {
      throw new Error(
        `[policy:${label}] a "deny" key appears after an "allow" key; findLast() would ` +
          `resolve to the deny and the allow would be dead`,
      );
    }
  }
  for (const key of NON_TOOL_PERMISSION_KEYS) {
    if (map[key] !== "deny") {
      throw new Error(`[policy:${label}] "${key}" must be pinned to "deny" (it defaults to "ask", which hangs headless)`);
    }
  }
}

export const AGENT_RESEARCH = "coldcall-research";
export const AGENT_EXTRACT = "coldcall-extract";
export const AGENT_WRITE = "coldcall-write";

const RESEARCH_PERMISSION = denyAllExcept(RESEARCH_TOOLS);
const LOCKED_PERMISSION = denyAllExcept([]);

/** Which agent serves a given tool policy, and at what temperature. */
export const AGENTS = {
  [AGENT_RESEARCH]: {
    mode: "primary",
    temperature: 0,
    description: "Read-only web research. Search and fetch only.",
    permission: RESEARCH_PERMISSION,
  },
  [AGENT_EXTRACT]: {
    mode: "primary",
    temperature: 0,
    description: "Deterministic text-to-JSON extraction. No tools.",
    permission: LOCKED_PERMISSION,
  },
  [AGENT_WRITE]: {
    mode: "primary",
    temperature: 0.7,
    description: "Prose writing. No tools.",
    permission: LOCKED_PERMISSION,
  },
} as const;

/** The complete per-request `tools` map for a policy. Never send a partial map - it replaces. */
export function toolsMapFor(policy: ToolPolicy): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  map["*"] = false;
  for (const id of KNOWN_TOOL_IDS) map[id] = false;
  for (const key of NON_TOOL_PERMISSION_KEYS) map[key] = false;
  if (policy === "research") {
    for (const id of RESEARCH_TOOLS) map[id] = true;
  }
  return map;
}

/** Tools a response is permitted to contain under a given policy. */
export function allowedToolsFor(policy: ToolPolicy): ReadonlySet<string> {
  return policy === "research" ? new Set<string>(RESEARCH_TOOLS) : new Set<string>();
}

export function agentFor(policy: ToolPolicy, kind: "extract" | "write"): string {
  if (policy === "research") return AGENT_RESEARCH;
  return kind === "write" ? AGENT_WRITE : AGENT_EXTRACT;
}

/** Process-wide permission floor, passed as OPENCODE_PERMISSION. */
export function processPermission(): PermissionMap {
  return LOCKED_PERMISSION;
}

/** Full inline config, passed as OPENCODE_CONFIG_CONTENT. Writes nothing to the user's disk. */
export function configContent(): unknown {
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    permission: LOCKED_PERMISSION,
    agent: AGENTS,
  };
}

/** Validate every shipped policy. Called at supervisor boot before spawning. */
export function assertAllPolicies(): void {
  assertPolicyOrder(RESEARCH_PERMISSION, AGENT_RESEARCH);
  assertPolicyOrder(LOCKED_PERMISSION, "locked");
  // Round-trip through JSON, since that is how it actually reaches opencode.
  const roundTripped = JSON.parse(JSON.stringify(configContent())) as {
    permission: PermissionMap;
    agent: Record<string, { permission: PermissionMap }>;
  };
  assertPolicyOrder(roundTripped.permission, "process(json)");
  for (const [name, agent] of Object.entries(roundTripped.agent)) {
    assertPolicyOrder(agent.permission, `${name}(json)`);
  }
}
