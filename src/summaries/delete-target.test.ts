import { describe, test, expect } from "bun:test";
import { resolveSummariesDeleteTarget } from "./delete-target.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";

const bot = (name: string, root = `/w/${name}`): WikiRegistryEntry =>
  ({ name, root, source: "bot" }) as WikiRegistryEntry;
const extra = (name: string): WikiRegistryEntry =>
  ({ name, root: `/x/${name}`, source: "extra" }) as WikiRegistryEntry;
const writable = { instanceReadonly: false, isReadonlyRoot: () => false };

describe("resolveSummariesDeleteTarget", () => {
  test("the default wiki when it is a bot wiki", () => {
    expect(resolveSummariesDeleteTarget([bot("melosys"), bot("jarvis")], writable)).toEqual({ wiki: "jarvis" });
  });
  test("a standalone default falls through to the first BOT wiki — the route 400s a standalone", () => {
    expect(resolveSummariesDeleteTarget([extra("notes"), bot("capra")], writable)).toEqual({ wiki: "capra" });
  });
  test("no bot wiki at all ⇒ no button", () => {
    expect(resolveSummariesDeleteTarget([extra("notes")], writable)).toBeNull();
    expect(resolveSummariesDeleteTarget([], writable)).toBeNull();
  });
  test("a wiki-readonly instance ⇒ no button, whatever the registry", () => {
    expect(resolveSummariesDeleteTarget([bot("jarvis")], { ...writable, instanceReadonly: true })).toBeNull();
  });
  test("a read-only bot DEFAULT ⇒ no button, even with a writable bot wiki behind it — never re-point the delete at another bot's drafts", () => {
    const ro = { ...writable, isReadonlyRoot: (r: string) => r === "/ro/jarvis" };
    expect(resolveSummariesDeleteTarget([bot("jarvis", "/ro/jarvis")], ro)).toBeNull();
    expect(resolveSummariesDeleteTarget([bot("jarvis", "/ro/jarvis"), bot("capra")], ro)).toBeNull();
  });
  test("a standalone default falls through to the first bot wiki, and THAT one's read-only root still refuses", () => {
    const ro = { ...writable, isReadonlyRoot: (r: string) => r === "/ro/capra" };
    expect(resolveSummariesDeleteTarget([extra("notes"), bot("capra", "/ro/capra"), bot("melosys")], ro)).toBeNull();
  });
});
