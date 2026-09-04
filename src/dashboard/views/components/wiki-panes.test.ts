import { describe, expect, test } from "bun:test";
import { paneKeyAction, parseStoredRightCollapsed, serializeRightCollapsed } from "./wiki-panes.ts";

describe("stored right-pane preference", () => {
  test("only the exact literal reads as collapsed", () => {
    expect(parseStoredRightCollapsed("collapsed")).toBe(true);
    expect(parseStoredRightCollapsed("open")).toBe(false);
    expect(parseStoredRightCollapsed("Collapsed")).toBe(false);
    expect(parseStoredRightCollapsed("true")).toBe(false);
    expect(parseStoredRightCollapsed("")).toBe(false);
    expect(parseStoredRightCollapsed(null)).toBe(false);
    expect(parseStoredRightCollapsed(undefined)).toBe(false);
  });

  test("serialize round-trips, and open clears the key", () => {
    expect(parseStoredRightCollapsed(serializeRightCollapsed(true))).toBe(true);
    expect(serializeRightCollapsed(false)).toBeNull();
  });
});

describe("paneKeyAction", () => {
  test("the three keys map on a plain body target", () => {
    expect(paneKeyAction({ key: "]", targetTag: "BODY" })).toBe("toggle-right");
    expect(paneKeyAction({ key: "f", targetTag: "body" })).toBe("toggle-focus");
    expect(paneKeyAction({ key: "F", targetTag: "DIV" })).toBe("toggle-focus");
    expect(paneKeyAction({ key: "Escape", targetTag: "BODY" })).toBe("exit-focus");
  });

  test("other keys, including the left bracket, do nothing", () => {
    expect(paneKeyAction({ key: "[", targetTag: "BODY" })).toBeNull();
    expect(paneKeyAction({ key: "g", targetTag: "BODY" })).toBeNull();
    expect(paneKeyAction({ key: "Enter", targetTag: "BODY" })).toBeNull();
  });

  test("refused while typing: input, textarea, select, contenteditable", () => {
    for (const targetTag of ["INPUT", "textarea", "SELECT"]) {
      expect(paneKeyAction({ key: "]", targetTag })).toBeNull();
      expect(paneKeyAction({ key: "f", targetTag })).toBeNull();
    }
    expect(paneKeyAction({ key: "f", targetTag: "DIV", targetEditable: true })).toBeNull();
  });

  test("refused with a modifier or on repeat (⌘F is the browser's find)", () => {
    expect(paneKeyAction({ key: "f", targetTag: "BODY", metaKey: true })).toBeNull();
    expect(paneKeyAction({ key: "f", targetTag: "BODY", ctrlKey: true })).toBeNull();
    expect(paneKeyAction({ key: "]", targetTag: "BODY", altKey: true })).toBeNull();
    expect(paneKeyAction({ key: "f", targetTag: "BODY", repeat: true })).toBeNull();
  });

  test("Escape inside a dialog belongs to the dialog", () => {
    expect(paneKeyAction({ key: "Escape", targetTag: "BUTTON", targetInDialog: true })).toBeNull();
    // …but ] and F are not dialog-owned keys, only Escape is
    expect(paneKeyAction({ key: "]", targetTag: "BUTTON", targetInDialog: true })).toBe("toggle-right");
  });
});
