import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  createConnector,
  getConnector,
  listConnectors,
  updateConnector,
  deleteConnector,
  seedConnectorsFromBotConfigs,
} from "./connectors.ts";
import { createThread } from "./threads.ts";
import type { BotConfig } from "../bots/config.ts";

setupTestDb();

function makeBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    name: "testbot",
    dir: "/tmp/testbot",
    persona: "test persona",
    telegramAllowedUserIds: ["u1"],
    slackAllowedUserIds: [],
    ...overrides,
  };
}

describe("connectors", () => {
  describe("createConnector", () => {
    test("creates a connector and returns it", async () => {
      const connector = await createConnector({
        name: "Test CLI",
        connectorType: "claude-cli",
        model: "sonnet",
      });

      expect(connector.id).toBeTruthy();
      expect(connector.name).toBe("Test CLI");
      expect(connector.connectorType).toBe("claude-cli");
      expect(connector.model).toBe("sonnet");
      expect(connector.createdAt).toBeGreaterThan(0);
      expect(connector.updatedAt).toBeGreaterThan(0);
    });

    test("creates a connector with all fields", async () => {
      const connector = await createConnector({
        name: "Full Config",
        description: "A full connector config",
        connectorType: "openai-compat",
        model: "qwen3.5:35b",
        baseUrl: "http://localhost:11434/v1",
        thinkingMaxTokens: 8000,
        timeoutMs: 60000,
      });

      expect(connector.name).toBe("Full Config");
      expect(connector.description).toBe("A full connector config");
      expect(connector.connectorType).toBe("openai-compat");
      expect(connector.model).toBe("qwen3.5:35b");
      expect(connector.baseUrl).toBe("http://localhost:11434/v1");
      expect(connector.thinkingMaxTokens).toBe(8000);
      expect(connector.timeoutMs).toBe(60000);
    });

    test("creates a connector with minimal fields", async () => {
      const connector = await createConnector({
        name: "Minimal",
        connectorType: "copilot-sdk",
      });

      expect(connector.name).toBe("Minimal");
      expect(connector.model).toBeUndefined();
      expect(connector.baseUrl).toBeUndefined();
      expect(connector.thinkingMaxTokens).toBeUndefined();
      expect(connector.timeoutMs).toBeUndefined();
    });
  });

  describe("getConnector", () => {
    test("returns connector by id", async () => {
      const created = await createConnector({
        name: "Lookup Test",
        connectorType: "claude-cli",
        model: "opus",
      });

      const fetched = await getConnector(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("Lookup Test");
      expect(fetched!.model).toBe("opus");
    });

    test("returns null for non-existent id", async () => {
      const result = await getConnector("00000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });

  describe("listConnectors", () => {
    test("returns empty array when no connectors exist", async () => {
      const connectors = await listConnectors();
      expect(connectors).toHaveLength(0);
    });

    test("returns all connectors sorted by name", async () => {
      await createConnector({ name: "Zebra", connectorType: "claude-cli" });
      await createConnector({ name: "Alpha", connectorType: "copilot-sdk" });
      await createConnector({ name: "Middle", connectorType: "openai-compat" });

      const connectors = await listConnectors();
      expect(connectors).toHaveLength(3);
      expect(connectors[0]!.name).toBe("Alpha");
      expect(connectors[1]!.name).toBe("Middle");
      expect(connectors[2]!.name).toBe("Zebra");
    });
  });

  describe("updateConnector", () => {
    test("updates name", async () => {
      const created = await createConnector({ name: "Old Name", connectorType: "claude-cli" });
      const updated = await updateConnector(created.id, { name: "New Name" });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
    });

    test("updates model", async () => {
      const created = await createConnector({ name: "Model Test", connectorType: "claude-cli", model: "sonnet" });
      const updated = await updateConnector(created.id, { model: "opus" });

      expect(updated!.model).toBe("opus");
    });

    test("clears a field with explicit null", async () => {
      const created = await createConnector({
        name: "Clear Test",
        connectorType: "openai-compat",
        model: "some-model",
        baseUrl: "http://localhost:11434/v1",
      });

      const updated = await updateConnector(created.id, { baseUrl: null });
      expect(updated!.baseUrl).toBeUndefined();
      // model should remain unchanged
      expect(updated!.model).toBe("some-model");
    });

    test("returns existing connector when no fields provided", async () => {
      const created = await createConnector({ name: "No Change", connectorType: "claude-cli" });
      const result = await updateConnector(created.id, {});

      expect(result).not.toBeNull();
      expect(result!.name).toBe("No Change");
    });

    test("returns null for non-existent id", async () => {
      const result = await updateConnector("00000000-0000-0000-0000-000000000000", { name: "nope" });
      expect(result).toBeNull();
    });

    test("updates multiple fields at once", async () => {
      const created = await createConnector({
        name: "Multi",
        connectorType: "claude-cli",
        model: "sonnet",
        timeoutMs: 30000,
      });

      const updated = await updateConnector(created.id, {
        name: "Multi Updated",
        connectorType: "copilot-sdk",
        model: "opus",
        timeoutMs: 60000,
      });

      expect(updated!.name).toBe("Multi Updated");
      expect(updated!.connectorType).toBe("copilot-sdk");
      expect(updated!.model).toBe("opus");
      expect(updated!.timeoutMs).toBe(60000);
    });
  });

  describe("deleteConnector", () => {
    test("deletes a connector", async () => {
      const created = await createConnector({ name: "Delete Me", connectorType: "claude-cli" });
      const deleted = await deleteConnector(created.id);
      expect(deleted).toBe(true);

      const fetched = await getConnector(created.id);
      expect(fetched).toBeNull();
    });

    test("returns false for non-existent id", async () => {
      const deleted = await deleteConnector("00000000-0000-0000-0000-000000000000");
      expect(deleted).toBe(false);
    });

    test("throws when connector is referenced by a thread", async () => {
      const connector = await createConnector({ name: "In Use", connectorType: "copilot-sdk" });
      // Create a thread that references this connector
      await createThread("u1", "bot1", "linked-thread", undefined, connector.id);

      await expect(deleteConnector(connector.id)).rejects.toThrow(
        "Cannot delete connector: it is referenced by one or more threads",
      );

      // Connector should still exist
      const fetched = await getConnector(connector.id);
      expect(fetched).not.toBeNull();
    });
  });

  describe("seedConnectorsFromBotConfigs", () => {
    test("seeds connectors from bot configs when table is empty", async () => {
      const configs: BotConfig[] = [
        makeBotConfig({ connector: "claude-cli", model: "sonnet" }),
        makeBotConfig({ connector: "openai-compat", model: "qwen3.5:35b", baseUrl: "http://localhost:11434/v1" }),
      ];

      const created = await seedConnectorsFromBotConfigs(configs);
      // Should create the 2 from configs + 1 copilot-sdk default
      expect(created).toBe(3);

      const all = await listConnectors();
      expect(all.length).toBe(3);
      const types = all.map((c) => c.connectorType).sort();
      expect(types).toEqual(["claude-cli", "copilot-sdk", "openai-compat"]);
    });

    test("deduplicates by connector_type + model + baseUrl", async () => {
      const configs: BotConfig[] = [
        makeBotConfig({ connector: "claude-cli", model: "sonnet" }),
        makeBotConfig({ connector: "claude-cli", model: "sonnet" }), // duplicate
      ];

      const created = await seedConnectorsFromBotConfigs(configs);
      // 1 unique from configs + 1 copilot-sdk default = 2
      expect(created).toBe(2);

      const all = await listConnectors();
      expect(all.length).toBe(2);
    });

    test("does not seed when table already has entries", async () => {
      // Pre-populate
      await createConnector({ name: "Existing", connectorType: "claude-cli" });

      const configs: BotConfig[] = [
        makeBotConfig({ connector: "openai-compat", model: "llama" }),
      ];

      const created = await seedConnectorsFromBotConfigs(configs);
      expect(created).toBe(0);

      // Should still only have the original entry (plus possibly the auto-seeded copilot-sdk)
      const all = await listConnectors();
      // The existing one + possibly auto-ensured copilot-sdk
      const types = all.map((c) => c.connectorType);
      expect(types).toContain("claude-cli");
      expect(types).not.toContain("openai-compat");
    });

    test("ensures copilot-sdk entry exists even when table is populated", async () => {
      // Pre-populate with a non-copilot connector
      await createConnector({ name: "Existing CLI", connectorType: "claude-cli" });

      await seedConnectorsFromBotConfigs([]);

      const all = await listConnectors();
      const copilot = all.find((c) => c.connectorType === "copilot-sdk");
      expect(copilot).toBeDefined();
    });
  });
});
