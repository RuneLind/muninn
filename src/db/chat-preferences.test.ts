import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getChatPreferences, setPreferredConnector } from "./chat-preferences.ts";
import { createConnector, deleteConnector } from "./connectors.ts";

setupTestDb();

describe("chat-preferences", () => {
  describe("getChatPreferences", () => {
    test("returns null connector when no preference set", async () => {
      const prefs = await getChatPreferences("u1", "bot1");
      expect(prefs.userId).toBe("u1");
      expect(prefs.botName).toBe("bot1");
      expect(prefs.preferredConnectorId).toBeNull();
    });
  });

  describe("setPreferredConnector", () => {
    test("sets a preferred connector for user+bot", async () => {
      const connector = await createConnector({ name: "Test", connectorType: "copilot-sdk" });
      await setPreferredConnector("u1", "bot1", connector.id);

      const prefs = await getChatPreferences("u1", "bot1");
      expect(prefs.preferredConnectorId).toBe(connector.id);
    });

    test("sets null to clear preferred connector", async () => {
      const connector = await createConnector({ name: "Clear Test", connectorType: "claude-cli" });
      await setPreferredConnector("u1", "bot1", connector.id);

      // Now clear it
      await setPreferredConnector("u1", "bot1", null);

      const prefs = await getChatPreferences("u1", "bot1");
      expect(prefs.preferredConnectorId).toBeNull();
    });

    test("overwrites existing preference", async () => {
      const connector1 = await createConnector({ name: "First", connectorType: "claude-cli" });
      const connector2 = await createConnector({ name: "Second", connectorType: "copilot-sdk", model: "opus" });

      await setPreferredConnector("u1", "bot1", connector1.id);
      const before = await getChatPreferences("u1", "bot1");
      expect(before.preferredConnectorId).toBe(connector1.id);

      await setPreferredConnector("u1", "bot1", connector2.id);
      const after = await getChatPreferences("u1", "bot1");
      expect(after.preferredConnectorId).toBe(connector2.id);
    });

    test("preferences are scoped to user+bot pair", async () => {
      const connector1 = await createConnector({ name: "For u1", connectorType: "claude-cli" });
      const connector2 = await createConnector({ name: "For u2", connectorType: "copilot-sdk", model: "opus" });

      await setPreferredConnector("u1", "bot1", connector1.id);
      await setPreferredConnector("u2", "bot1", connector2.id);

      const u1Prefs = await getChatPreferences("u1", "bot1");
      const u2Prefs = await getChatPreferences("u2", "bot1");
      expect(u1Prefs.preferredConnectorId).toBe(connector1.id);
      expect(u2Prefs.preferredConnectorId).toBe(connector2.id);
    });

    test("preferences are scoped to bot", async () => {
      const connector1 = await createConnector({ name: "Bot1 Conn", connectorType: "claude-cli" });
      const connector2 = await createConnector({ name: "Bot2 Conn", connectorType: "copilot-sdk", model: "opus" });

      await setPreferredConnector("u1", "bot1", connector1.id);
      await setPreferredConnector("u1", "bot2", connector2.id);

      const bot1Prefs = await getChatPreferences("u1", "bot1");
      const bot2Prefs = await getChatPreferences("u1", "bot2");
      expect(bot1Prefs.preferredConnectorId).toBe(connector1.id);
      expect(bot2Prefs.preferredConnectorId).toBe(connector2.id);
    });
  });

  describe("FK handling", () => {
    test("preferred_connector_id is set to null when connector is deleted (ON DELETE SET NULL)", async () => {
      const connector = await createConnector({ name: "Will Delete", connectorType: "claude-cli" });
      await setPreferredConnector("u1", "bot1", connector.id);

      // Verify it's set
      const before = await getChatPreferences("u1", "bot1");
      expect(before.preferredConnectorId).toBe(connector.id);

      // Delete the connector
      await deleteConnector(connector.id);

      // The FK ON DELETE SET NULL should clear the reference
      const after = await getChatPreferences("u1", "bot1");
      expect(after.preferredConnectorId).toBeNull();
    });
  });
});
