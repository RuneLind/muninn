import { test, expect } from "bun:test";
import { parseHivemindConfig, DEFAULT_ASK_PEER_TIMEOUT_SEC } from "./config.ts";

test("returns null when block is missing or disabled", () => {
  expect(parseHivemindConfig(undefined)).toBeNull();
  expect(parseHivemindConfig(null)).toBeNull();
  expect(parseHivemindConfig({})).toBeNull();
  expect(parseHivemindConfig({ enabled: false, namespaces: ["private"] })).toBeNull();
});

test("returns null when namespaces is empty or invalid", () => {
  expect(parseHivemindConfig({ enabled: true })).toBeNull();
  expect(parseHivemindConfig({ enabled: true, namespaces: [] })).toBeNull();
  expect(parseHivemindConfig({ enabled: true, namespaces: [123, ""] })).toBeNull();
});

test("parses minimal valid config", () => {
  const cfg = parseHivemindConfig({ enabled: true, namespaces: ["private"] });
  expect(cfg).toEqual({
    enabled: true,
    namespaces: ["private"],
    summary: undefined,
    autoRespondPeers: undefined,
    askPeerDefaultTimeoutSec: undefined,
    exposeToTools: true,
  });
});

test("parses full config", () => {
  const cfg = parseHivemindConfig({
    enabled: true,
    namespaces: ["private", "nav"],
    summary: "Melosys peer",
    autoRespondPeers: ["huginn", "yggdrasil"],
    askPeerDefaultTimeoutSec: 30,
    exposeToTools: false,
  });
  expect(cfg).toEqual({
    enabled: true,
    namespaces: ["private", "nav"],
    summary: "Melosys peer",
    autoRespondPeers: ["huginn", "yggdrasil"],
    askPeerDefaultTimeoutSec: 30,
    exposeToTools: false,
  });
});

test("filters non-string entries from autoRespondPeers", () => {
  const cfg = parseHivemindConfig({
    enabled: true,
    namespaces: ["private"],
    autoRespondPeers: ["huginn", 42, null, "yggdrasil"],
  });
  expect(cfg?.autoRespondPeers).toEqual(["huginn", "yggdrasil"]);
});

test("ignores invalid askPeerDefaultTimeoutSec", () => {
  const cfg = parseHivemindConfig({
    enabled: true,
    namespaces: ["private"],
    askPeerDefaultTimeoutSec: -10,
  });
  expect(cfg?.askPeerDefaultTimeoutSec).toBeUndefined();
});

test("DEFAULT_ASK_PEER_TIMEOUT_SEC is positive", () => {
  expect(DEFAULT_ASK_PEER_TIMEOUT_SEC).toBeGreaterThan(0);
});

test("devLoop is undefined when absent or empty (v1 park-and-confirm)", () => {
  expect(parseHivemindConfig({ enabled: true, namespaces: ["private"] })?.devLoop).toBeUndefined();
  expect(
    parseHivemindConfig({ enabled: true, namespaces: ["private"], devLoop: {} })?.devLoop,
  ).toBeUndefined();
  // Non-boolean values are ignored, leaving the block empty → undefined.
  expect(
    parseHivemindConfig({
      enabled: true,
      namespaces: ["private"],
      devLoop: { autoOrchestrate: "yes", autoReengageOnRed: 1 },
    })?.devLoop,
  ).toBeUndefined();
});

test("devLoop parses autoOrchestrate + autoReengageOnRed (PR 6a + 6b)", () => {
  const cfg = parseHivemindConfig({
    enabled: true,
    namespaces: ["private"],
    devLoop: { autoOrchestrate: true, autoReengageOnRed: true },
  });
  expect(cfg?.devLoop).toEqual({ autoOrchestrate: true, autoReengageOnRed: true });

  // The two flags are independent — either can be set alone.
  expect(
    parseHivemindConfig({
      enabled: true,
      namespaces: ["private"],
      devLoop: { autoReengageOnRed: true },
    })?.devLoop,
  ).toEqual({ autoReengageOnRed: true });
});

test("devLoop parses reengageClassifier (PR 6b classifier follow-up)", () => {
  expect(
    parseHivemindConfig({
      enabled: true,
      namespaces: ["private"],
      devLoop: { autoReengageOnRed: true, reengageClassifier: true },
    })?.devLoop,
  ).toEqual({ autoReengageOnRed: true, reengageClassifier: true });

  // Non-boolean reengageClassifier is ignored.
  expect(
    parseHivemindConfig({
      enabled: true,
      namespaces: ["private"],
      devLoop: { reengageClassifier: "sometimes" },
    })?.devLoop,
  ).toBeUndefined();
});
