import { test, expect } from "bun:test";
import { categoryToDomain, clientDomainMapJson } from "./domain.ts";

test("ai/* sub-categories map to ai", () => {
  expect(categoryToDomain("ai/claude-code")).toBe("ai");
  expect(categoryToDomain("ai/claude")).toBe("ai");
  expect(categoryToDomain("ai/rag")).toBe("ai");
  expect(categoryToDomain("ai/general")).toBe("ai");
  expect(categoryToDomain("ai/openclaw")).toBe("ai");
  expect(categoryToDomain("ai")).toBe("ai");
});

test("tech / coding / career map to ai", () => {
  expect(categoryToDomain("tech")).toBe("ai");
  expect(categoryToDomain("coding")).toBe("ai");
  expect(categoryToDomain("career")).toBe("ai");
});

test("health / parenting / entertainment map to life", () => {
  expect(categoryToDomain("health")).toBe("life");
  expect(categoryToDomain("parenting")).toBe("life");
  expect(categoryToDomain("entertainment")).toBe("life");
});

test("unknown / legacy categories default to ai", () => {
  expect(categoryToDomain("uncategorized")).toBe("ai");
  expect(categoryToDomain("misc")).toBe("ai");
  expect(categoryToDomain("")).toBe("ai");
  expect(categoryToDomain("some/legacy/folder")).toBe("ai");
});

test("clientDomainMapJson round-trips to a usable lookup table", () => {
  const map = JSON.parse(clientDomainMapJson()) as Record<string, string>;
  expect(map.ai).toBe("ai");
  expect(map.health).toBe("life");
  expect(map.parenting).toBe("life");
  expect(map.entertainment).toBe("life");
  expect(map.tech).toBe("ai");
  // Client mirror of categoryToDomain: split on "/", look up top, default "ai".
  const domainOf = (cat: string) => map[cat.split("/")[0] ?? ""] ?? "ai";
  expect(domainOf("ai/claude-code")).toBe("ai");
  expect(domainOf("health")).toBe("life");
  expect(domainOf("unknown")).toBe("ai");
});
