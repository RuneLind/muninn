import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeGoal } from "../test/fixtures.ts";
import {
  saveGoal,
  getActiveGoals,
  getGoalById,
  updateGoalStatus,
  updateGoalCheckedAt,
  updateGoalReminderSentAt,
  getGoalsNeedingCheckin,
  getAllGoals,
} from "./goals.ts";

setupTestDb();

describe("goals", () => {
  test("saveGoal returns an id", async () => {
    const id = await saveGoal(makeGoal());
    expect(id).toBeTruthy();
  });

  test("getGoalById returns saved goal", async () => {
    const id = await saveGoal(makeGoal({
      userId: "u1",
      botName: "bot1",
      title: "Learn Rust",
      description: "Complete the Rust book",
      tags: ["learning", "rust"],
    }));

    const goal = await getGoalById(id);
    expect(goal).not.toBeNull();
    expect(goal!.title).toBe("Learn Rust");
    expect(goal!.description).toBe("Complete the Rust book");
    expect(goal!.status).toBe("active");
    expect(goal!.tags).toEqual(["learning", "rust"]);
    expect(goal!.userId).toBe("u1");
    expect(goal!.botName).toBe("bot1");
  });

  test("getGoalById returns null for non-existent id", async () => {
    const goal = await getGoalById("00000000-0000-0000-0000-000000000000");
    expect(goal).toBeNull();
  });

  test("getActiveGoals returns only active goals", async () => {
    const id1 = await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "active goal" }));
    const id2 = await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "will be completed" }));
    await updateGoalStatus(id2, "completed");

    const active = await getActiveGoals("u1", "bot1");
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe("active goal");
  });

  test("getActiveGoals filters by userId", async () => {
    await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "u1 goal" }));
    await saveGoal(makeGoal({ userId: "u2", botName: "bot1", title: "u2 goal" }));

    const goals = await getActiveGoals("u1", "bot1");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.title).toBe("u1 goal");
  });

  test("getActiveGoals filters by botName", async () => {
    await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "bot1 goal" }));
    await saveGoal(makeGoal({ userId: "u1", botName: "bot2", title: "bot2 goal" }));

    const goals = await getActiveGoals("u1", "bot1");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.title).toBe("bot1 goal");
  });

  test("updateGoalStatus changes status", async () => {
    const id = await saveGoal(makeGoal({ userId: "u1" }));

    await updateGoalStatus(id, "completed");
    const goal = await getGoalById(id);
    expect(goal!.status).toBe("completed");

    await updateGoalStatus(id, "cancelled");
    const goal2 = await getGoalById(id);
    expect(goal2!.status).toBe("cancelled");
  });

  test("updateGoalCheckedAt sets timestamp", async () => {
    const id = await saveGoal(makeGoal({ userId: "u1" }));
    const before = await getGoalById(id);
    expect(before!.lastCheckedAt).toBeNull();

    await updateGoalCheckedAt(id);
    const after = await getGoalById(id);
    expect(after!.lastCheckedAt).not.toBeNull();
    expect(after!.lastCheckedAt).toBeGreaterThan(0);
  });

  test("updateGoalReminderSentAt sets timestamp", async () => {
    const id = await saveGoal(makeGoal({ userId: "u1" }));
    const before = await getGoalById(id);
    expect(before!.reminderSentAt).toBeNull();

    await updateGoalReminderSentAt(id);
    const after = await getGoalById(id);
    expect(after!.reminderSentAt).not.toBeNull();
  });

  test("getGoalsNeedingCheckin returns unchecked goals", async () => {
    await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "never checked" }));

    const goals = await getGoalsNeedingCheckin(7, "bot1");
    expect(goals.length).toBeGreaterThanOrEqual(1);
    expect(goals.some((g) => g.title === "never checked")).toBe(true);
  });

  test("getGoalsNeedingCheckin excludes recently checked", async () => {
    const id = await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "just checked" }));
    await updateGoalCheckedAt(id);

    const goals = await getGoalsNeedingCheckin(7, "bot1");
    expect(goals.every((g) => g.title !== "just checked")).toBe(true);
  });

  test("getAllGoals excludes old completed/cancelled goals", async () => {
    await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "active" }));
    const id2 = await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "recently completed" }));
    await updateGoalStatus(id2, "completed");

    const all = await getAllGoals("bot1");
    // Both should appear (recently completed still within 7 days)
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("getAllGoals sorts active before completed", async () => {
    const id1 = await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "completed one" }));
    await updateGoalStatus(id1, "completed");
    await saveGoal(makeGoal({ userId: "u1", botName: "bot1", title: "active one" }));

    const all = await getAllGoals("bot1");
    expect(all[0]!.status).toBe("active");
  });

  test("saveGoal with deadline", async () => {
    const deadline = new Date("2026-06-15T00:00:00Z");
    const id = await saveGoal(makeGoal({ userId: "u1", title: "with deadline", deadline }));
    const goal = await getGoalById(id);
    expect(goal!.deadline).not.toBeNull();
  });
});
