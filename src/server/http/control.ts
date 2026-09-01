/**
 * Explicit, tab-scoped control for the shared coldcall surface.
 *
 * This is deliberately in memory. Control is a live permission, not a durable entitlement:
 * restarting coldcall, closing the tab, revoking the session, or missing the heartbeat turns it
 * off. Commands are addressed to a shared session and tab, and the browser still has to grant
 * them before anything is executed.
 */
import { randomBytes } from "node:crypto";
import { now } from "../db/index.ts";

const REQUEST_TTL = 60_000;
const ACTIVE_TTL = 15_000;
const MAX_VALUE = 20_000;
const MAX_ID = 100;

export type ControlStatus = "requested" | "active";
export interface ControlTarget {
  sessionId: string;
  tabId: string;
  replaySessionId?: string;
}
export interface ControlState extends ControlTarget {
  status: ControlStatus;
  requestedAt: number;
  grantedAt?: number;
  lastAt: number;
}
export interface ControlCommand {
  type: "click" | "focus" | "type" | "scroll" | "navigate" | "pointer";
  controlId?: string;
  value?: string;
  x?: number;
  y?: number;
  route?: string;
  visible?: boolean;
}

const controls = new Map<string, ControlState>();
const commandQueues = new Map<string, Array<{ commandId: string; control: ControlState; command: ControlCommand }>>();
const keyOf = (sessionId: string, tabId: string): string => `${sessionId}:${tabId}`;
const shortId = (v: unknown): string => typeof v === "string"
  ? v.trim().slice(0, MAX_ID) : "";
const finite = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function cleanTarget(input: Partial<ControlTarget>): ControlTarget | undefined {
  const sessionId = shortId(input.sessionId);
  const tabId = shortId(input.tabId);
  if (!sessionId || !tabId) return undefined;
  const replaySessionId = shortId(input.replaySessionId);
  return replaySessionId ? { sessionId, tabId, replaySessionId } : { sessionId, tabId };
}

export function cleanControlCommand(raw: unknown): ControlCommand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (!["click", "focus", "type", "scroll", "navigate", "pointer"].includes(String(type))) return undefined;

  if (type === "pointer") {
    const x = finite(r.x), y = finite(r.y);
    if (x === undefined || y === undefined) return undefined;
    return { type: "pointer", x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), visible: r.visible !== false };
  }

  if (type === "navigate") {
    const route = shortId(r.route);
    return route && /^[a-z][a-z0-9-]{0,50}$/.test(route) ? { type: "navigate", route } : undefined;
  }

  const controlId = shortId(r.controlId);
  if (!controlId || !/^[A-Za-z0-9_.:-]+$/.test(controlId)) return undefined;
  if (type === "type") {
    if (typeof r.value !== "string") return undefined;
    return { type: "type", controlId, value: r.value.slice(0, MAX_VALUE) };
  }
  if (type === "scroll") {
    const x = finite(r.x), y = finite(r.y);
    if (x === undefined || y === undefined) return undefined;
    return { type: "scroll", controlId, x: Math.max(0, Math.min(5_000_000, Math.round(x))), y: Math.max(0, Math.min(5_000_000, Math.round(y))) };
  }
  return { type: type as "click" | "focus", controlId };
}

function expire(): void {
  const t = now();
  for (const [key, state] of controls) {
    const ttl = state.status === "active" ? ACTIVE_TTL : REQUEST_TTL;
    if (t - state.lastAt > ttl) { controls.delete(key); commandQueues.delete(key); }
  }
}

export function requestControl(input: Partial<ControlTarget>): ControlState | undefined {
  expire();
  const target = cleanTarget(input);
  if (!target) return undefined;
  const t = now();
  const state: ControlState = { ...target, status: "requested", requestedAt: t, lastAt: t };
  controls.set(keyOf(target.sessionId, target.tabId), state);
  return state;
}

export function grantControl(input: Partial<ControlTarget>): ControlState | undefined {
  expire();
  const target = cleanTarget(input);
  if (!target) return undefined;
  const state = controls.get(keyOf(target.sessionId, target.tabId));
  if (!state || state.status !== "requested") return undefined;
  state.status = "active";
  state.grantedAt = now();
  state.lastAt = state.grantedAt;
  if (target.replaySessionId) state.replaySessionId = target.replaySessionId;
  return { ...state };
}

function clearCommandQueue(input: Partial<ControlTarget>): void {
  const target = cleanTarget(input);
  if (target) commandQueues.delete(keyOf(target.sessionId, target.tabId));
}

export function queueControlCommand(input: Partial<ControlTarget>, id: string, command: ControlCommand): boolean {
  expire();
  const target = cleanTarget(input);
  if (!target || !controls.has(keyOf(target.sessionId, target.tabId))) return false;
  const control = controls.get(keyOf(target.sessionId, target.tabId))!;
  const key = keyOf(target.sessionId, target.tabId);
  const queue = commandQueues.get(key) ?? [];
  // Pointer updates are presence, not a backlog. Keep only the newest one if SSE is delayed.
  if (command.type === "pointer") {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].command.type === "pointer") queue.splice(i, 1);
  }
  queue.push({ commandId: id, control: { ...control }, command });
  while (queue.length > 100) queue.shift();
  commandQueues.set(key, queue);
  return true;
}

export function takeControlCommands(input: Partial<ControlTarget>): Array<{ commandId: string; control: ControlState; command: ControlCommand }> {
  expire();
  const target = cleanTarget(input);
  if (!target) return [];
  const key = keyOf(target.sessionId, target.tabId);
  const state = controls.get(key);
  if (!state || state.status !== "active") return [];
  const queue = commandQueues.get(key) ?? [];
  commandQueues.delete(key);
  return queue;
}

export function acknowledgeControlCommand(input: Partial<ControlTarget>, id: string): void {
  const target = cleanTarget(input);
  if (!target) return;
  const key = keyOf(target.sessionId, target.tabId);
  const queue = commandQueues.get(key);
  if (!queue) return;
  const remaining = queue.filter((item) => item.commandId !== id);
  if (remaining.length) commandQueues.set(key, remaining); else commandQueues.delete(key);
}

export function denyControl(input: Partial<ControlTarget>): boolean {
  const target = cleanTarget(input);
  if (!target) return false;
  clearCommandQueue(target);
  return controls.delete(keyOf(target.sessionId, target.tabId));
}

export function releaseControl(input: Partial<ControlTarget>): boolean {
  const target = cleanTarget(input);
  if (!target) return false;
  clearCommandQueue(target);
  return controls.delete(keyOf(target.sessionId, target.tabId));
}

export function heartbeatControl(input: Partial<ControlTarget>): ControlState | undefined {
  expire();
  const target = cleanTarget(input);
  if (!target) return undefined;
  const state = controls.get(keyOf(target.sessionId, target.tabId));
  if (!state || state.status !== "active") return undefined;
  state.lastAt = now();
  return { ...state };
}

export function controlFor(input: Partial<ControlTarget>): ControlState | undefined {
  expire();
  const target = cleanTarget(input);
  if (!target) return undefined;
  const state = controls.get(keyOf(target.sessionId, target.tabId));
  return state ? { ...state } : undefined;
}

export function controlsForSession(sessionId: string): ControlState[] {
  expire();
  return [...controls.values()].filter((s) => s.sessionId === sessionId).map((s) => ({ ...s }));
}

export function allControls(): ControlState[] {
  expire();
  return [...controls.values()].map((s) => ({ ...s }));
}

export function commandId(): string {
  return randomBytes(12).toString("base64url");
}

export function clearControlsForSession(sessionId: string): void {
  for (const [key, state] of controls) if (state.sessionId === sessionId) {
    controls.delete(key); commandQueues.delete(key);
  }
  for (const key of commandQueues.keys()) if (key.startsWith(`${sessionId}:`)) commandQueues.delete(key);
}
export function clearControls(): void { controls.clear(); commandQueues.clear(); }
