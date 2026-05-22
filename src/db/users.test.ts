import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { ensureUser, getUser, getUsers, updateUser } from "./users.ts";
import { switchThread } from "./threads.ts";

setupTestDb();

describe("users", () => {
  describe("ensureUser (create)", () => {
    test("creates a new user", async () => {
      await ensureUser({ id: "tg-100", username: "alice", platform: "telegram" });

      const user = await getUser("tg-100");
      expect(user).not.toBeNull();
      expect(user!.id).toBe("tg-100");
      expect(user!.username).toBe("alice");
      expect(user!.platform).toBe("telegram");
      expect(user!.isActive).toBe(true);
      expect(user!.createdAt).toBeGreaterThan(0);
    });

    test("creates a user with displayName", async () => {
      await ensureUser({ id: "tg-101", username: "bob", displayName: "Bob Smith", platform: "telegram" });

      const user = await getUser("tg-101");
      expect(user!.displayName).toBe("Bob Smith");
    });

    test("sets lastSeenAt on creation", async () => {
      await ensureUser({ id: "tg-102", username: "charlie", platform: "telegram" });

      const user = await getUser("tg-102");
      expect(user!.lastSeenAt).not.toBeNull();
      expect(user!.lastSeenAt).toBeGreaterThan(0);
    });
  });

  describe("getUser", () => {
    test("returns user by ID", async () => {
      await ensureUser({ id: "tg-200", username: "alice", platform: "telegram" });

      const user = await getUser("tg-200");
      expect(user).not.toBeNull();
      expect(user!.id).toBe("tg-200");
      expect(user!.username).toBe("alice");
    });

    test("returns null for non-existent ID", async () => {
      const user = await getUser("nonexistent");
      expect(user).toBeNull();
    });

    test("returns user by telegram ID (id is the telegram ID)", async () => {
      const telegramId = "123456789";
      await ensureUser({ id: telegramId, username: "tguser", platform: "telegram" });

      const user = await getUser(telegramId);
      expect(user).not.toBeNull();
      expect(user!.id).toBe(telegramId);
      expect(user!.platform).toBe("telegram");
    });
  });

  describe("ensureUser (update username)", () => {
    test("updates username when new non-empty name provided", async () => {
      await ensureUser({ id: "tg-300", username: "oldname", platform: "telegram" });
      await ensureUser({ id: "tg-300", username: "newname", platform: "telegram" });

      const user = await getUser("tg-300");
      expect(user!.username).toBe("newname");
    });

    test("does not overwrite username with empty string", async () => {
      await ensureUser({ id: "tg-301", username: "keepme", platform: "telegram" });
      await ensureUser({ id: "tg-301", username: "", platform: "telegram" });

      const user = await getUser("tg-301");
      expect(user!.username).toBe("keepme");
    });

    test("does not overwrite username with the user ID", async () => {
      await ensureUser({ id: "tg-302", username: "realname", platform: "telegram" });
      // When username equals the id, it should be treated as a non-meaningful name
      await ensureUser({ id: "tg-302", username: "tg-302", platform: "telegram" });

      const user = await getUser("tg-302");
      expect(user!.username).toBe("realname");
    });

    test("does not overwrite username with the 'chat-user' placeholder", async () => {
      await ensureUser({ id: "web-400", username: "rune-tester-4", platform: "web" });
      // A peer-recreated conversation shell defaults to "chat-user"; it must not
      // clobber the user's real name.
      await ensureUser({ id: "web-400", username: "chat-user", platform: "web" });

      const user = await getUser("web-400");
      expect(user!.username).toBe("rune-tester-4");
    });

    test("updates lastSeenAt on subsequent calls", async () => {
      await ensureUser({ id: "tg-303", username: "alice", platform: "telegram" });
      const first = await getUser("tg-303");

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      await ensureUser({ id: "tg-303", username: "alice", platform: "telegram" });
      const second = await getUser("tg-303");

      expect(second!.lastSeenAt).toBeGreaterThanOrEqual(first!.lastSeenAt!);
    });

    test("updates displayName via ensureUser", async () => {
      await ensureUser({ id: "tg-304", username: "alice", platform: "telegram" });
      await ensureUser({ id: "tg-304", username: "alice", displayName: "Alice W.", platform: "telegram" });

      const user = await getUser("tg-304");
      expect(user!.displayName).toBe("Alice W.");
    });

    test("does not clear existing displayName when not provided", async () => {
      await ensureUser({ id: "tg-305", username: "alice", displayName: "Alice", platform: "telegram" });
      await ensureUser({ id: "tg-305", username: "alice", platform: "telegram" });

      const user = await getUser("tg-305");
      expect(user!.displayName).toBe("Alice");
    });
  });

  describe("getUsers (list)", () => {
    test("returns all active users", async () => {
      await ensureUser({ id: "tg-400", username: "alice", platform: "telegram" });
      await ensureUser({ id: "tg-401", username: "bob", platform: "telegram" });

      const users = await getUsers();
      expect(users.length).toBeGreaterThanOrEqual(2);
      const ids = users.map((u) => u.id);
      expect(ids).toContain("tg-400");
      expect(ids).toContain("tg-401");
    });

    test("excludes inactive users", async () => {
      await ensureUser({ id: "tg-410", username: "active", platform: "telegram" });
      await ensureUser({ id: "tg-411", username: "inactive", platform: "telegram" });
      await updateUser("tg-411", { isActive: false });

      const users = await getUsers();
      const ids = users.map((u) => u.id);
      expect(ids).toContain("tg-410");
      expect(ids).not.toContain("tg-411");
    });

    test("filters by botName (users with threads for that bot)", async () => {
      await ensureUser({ id: "tg-420", username: "alice", platform: "telegram" });
      await ensureUser({ id: "tg-421", username: "bob", platform: "telegram" });
      // Only alice has a thread for bot1
      await switchThread("tg-420", "bot1", "main");

      const users = await getUsers("bot1");
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe("tg-420");
    });

    test("returns empty array when no users exist for bot", async () => {
      const users = await getUsers("nonexistent-bot");
      expect(users).toHaveLength(0);
    });
  });

  describe("updateUser", () => {
    test("updates username", async () => {
      await ensureUser({ id: "tg-500", username: "old", platform: "telegram" });
      await updateUser("tg-500", { username: "new" });

      const user = await getUser("tg-500");
      expect(user!.username).toBe("new");
    });

    test("updates displayName", async () => {
      await ensureUser({ id: "tg-501", username: "alice", platform: "telegram" });
      await updateUser("tg-501", { displayName: "Alice W." });

      const user = await getUser("tg-501");
      expect(user!.displayName).toBe("Alice W.");
    });

    test("updates isActive", async () => {
      await ensureUser({ id: "tg-502", username: "alice", platform: "telegram" });
      await updateUser("tg-502", { isActive: false });

      const user = await getUser("tg-502");
      expect(user!.isActive).toBe(false);
    });

    test("no-op when no fields provided", async () => {
      await ensureUser({ id: "tg-503", username: "alice", platform: "telegram" });
      await updateUser("tg-503", {});

      const user = await getUser("tg-503");
      expect(user!.username).toBe("alice");
    });

    test("updates multiple fields at once", async () => {
      await ensureUser({ id: "tg-504", username: "old", platform: "telegram" });
      await updateUser("tg-504", { username: "new", displayName: "New Name", isActive: false });

      const user = await getUser("tg-504");
      expect(user!.username).toBe("new");
      expect(user!.displayName).toBe("New Name");
      expect(user!.isActive).toBe(false);
    });
  });
});
