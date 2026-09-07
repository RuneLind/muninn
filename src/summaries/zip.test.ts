/**
 * The store-only ZIP writer, checked by the tool the reader will use on it:
 * `unzip -t` verifies every CRC, `unzip -p` gives the bytes back. A writer
 * checked only against its own reader proves nothing about Finder.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStoredZip, crc32 } from "./zip.ts";

describe("crc32", () => {
  test("the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  test("empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("buildStoredZip", () => {
  test("unzip accepts the archive, lists every entry and returns the bytes verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muninn-zip-"));
    try {
      const jpg = new Uint8Array(1024);
      for (let i = 0; i < jpg.length; i++) jpg[i] = (i * 7) & 0xff;
      const html = new TextEncoder().encode("<!doctype html><title>Æøå</title>");
      const zip = buildStoredZip([
        { name: "index.html", data: html, mtime: new Date(2026, 8, 7, 10, 30, 12) },
        { name: "frames/187.jpg", data: jpg },
        { name: "frames/2280.jpg", data: new Uint8Array([1]) },
      ]);
      const path = join(dir, "out.zip");
      writeFileSync(path, zip);

      const test_ = await Bun.$`unzip -t ${path}`.text();
      expect(test_).toContain("No errors detected");

      await Bun.$`unzip -q -o ${path} -d ${join(dir, "out")}`;
      expect(readdirSync(join(dir, "out")).sort()).toEqual(["frames", "index.html"]);
      expect(readdirSync(join(dir, "out", "frames")).sort()).toEqual(["187.jpg", "2280.jpg"]);

      const back = new Uint8Array(await Bun.$`unzip -p ${path} frames/187.jpg`.arrayBuffer());
      expect(back).toEqual(jpg);
      expect(await Bun.$`unzip -p ${path} index.html`.text()).toBe("<!doctype html><title>Æøå</title>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-ASCII entry name is refused, never written", () => {
    expect(() => buildStoredZip([{ name: "frames/tøm.jpg", data: new Uint8Array([1]) }])).toThrow(/ASCII/);
  });

  test("an empty archive is still a valid archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muninn-zip-"));
    try {
      const path = join(dir, "empty.zip");
      writeFileSync(path, buildStoredZip([]));
      // `unzip -t` on an empty archive exits 1 ("zipfile is empty"); the
      // signature-level check is that the EOCD is where a reader looks for it.
      const bytes = buildStoredZip([]);
      expect(bytes.length).toBe(22);
      expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
