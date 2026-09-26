import { describe, expect, test } from "bun:test";
import { modalOpen, paneKeyAction, parseStoredRightCollapsed, readerKeyRefused } from "./wiki-panes.ts";

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

  test("every key is refused inside a modal dialog (fix round 1: f behind the Share dialog collapsed the reader)", () => {
    expect(paneKeyAction({ key: "Escape", targetTag: "BUTTON", targetInDialog: true })).toBeNull();
    expect(paneKeyAction({ key: "]", targetTag: "BUTTON", targetInDialog: true })).toBeNull();
    expect(paneKeyAction({ key: "f", targetTag: "BUTTON", targetInDialog: true })).toBeNull();
  });
});

describe("readerKeyRefused (fix round 2)", () => {
  test("a plain key on a plain target is not refused", () => {
    expect(readerKeyRefused({ key: "g", targetTag: "BODY" })).toBe(false);
    expect(readerKeyRefused({ key: "g", targetTag: "BUTTON" })).toBe(false);
    expect(readerKeyRefused({ key: "g" })).toBe(false);
  });
  test("each refusal on its own", () => {
    const base = { key: "g", targetTag: "BODY" };
    expect(readerKeyRefused({ ...base, ctrlKey: true })).toBe(true);
    expect(readerKeyRefused({ ...base, metaKey: true })).toBe(true);
    expect(readerKeyRefused({ ...base, altKey: true })).toBe(true);
    expect(readerKeyRefused({ ...base, repeat: true })).toBe(true);
    expect(readerKeyRefused({ ...base, targetInDialog: true })).toBe(true);
    expect(readerKeyRefused({ ...base, targetEditable: true })).toBe(true);
    for (const targetTag of ["INPUT", "input", "TEXTAREA", "textarea", "SELECT", "select"]) {
      expect(readerKeyRefused({ key: "g", targetTag }), targetTag).toBe(true);
    }
  });
});

describe("modalOpen (fix round 2)", () => {
  const el = (rects: number) => ({ getClientRects: () => ({ length: rects }) }) as unknown as Element;
  const rootOf = (els: Element[]) => {
    const asked: string[] = [];
    return {
      asked,
      querySelectorAll: ((sel: string) => {
        asked.push(sel);
        return els;
      }) as unknown as ParentNode["querySelectorAll"],
    };
  };
  test("asks for dialogs and menus, anywhere", () => {
    const root = rootOf([]);
    expect(modalOpen(root)).toBe(false);
    const sel = root.asked.join(",");
    for (const part of ['[aria-modal="true"]', "dialog[open]", '[role="dialog"]', '[role="menu"]']) expect(sel).toContain(part);
  });
  test("only a rendered one counts: a hidden menu kept in the DOM has no client rects", () => {
    expect(modalOpen(rootOf([el(0)]))).toBe(false);
    expect(modalOpen(rootOf([el(1)]))).toBe(true);
    expect(modalOpen(rootOf([el(0), el(2)]))).toBe(true);
  });
});
