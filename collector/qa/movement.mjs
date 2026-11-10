import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inputDriver } from "./input-driver.mjs";

export const travelKeys = ["walk", "swim", "fly", "glide", "vehicle"].map(
  (mode) => `travel.${mode}_millimeters`,
);
export const movementKeys = [...travelKeys, "activity.millis"];

export async function verifyMovement({
  bot,
  command,
  until,
  diagnostics,
  tool,
  serverId,
  playerKey,
  probeOnly,
  idleSeconds,
  thresholdOnly,
  cache,
  bootId,
  beforeBoot,
  activityStart,
  replayBatch,
}) {
  const driver = inputDriver(bot);
  const query = (dimension) =>
    tool("get_player_statistics", {
      serverId,
      playerKey,
      ...(dimension ? { dimension } : {}),
    });
  const value = (summary, key) =>
    BigInt(summary.metrics.find((metric) => metric.key === key)?.value ?? 0);
  const values = (summary) =>
    Object.fromEntries(movementKeys.map((key) => [key, value(summary, key)]));
  const baseline = values(await query());
  const cases = [];
  const block = { x: 0, y: 0, z: 0 };
  let held,
    snapshots = 0;
  bot.on("inventory_content", (packet) => {
    if (["inventory", 0].includes(packet.window_id)) {
      held = packet.input[0];
      snapshots++;
    }
  });
  bot.on("inventory_slot", (packet) => {
    if (["inventory", 0].includes(packet.window_id) && packet.slot === 0)
      held = packet.item;
  });
  const chat = (message) =>
    bot.queue("text", {
      category: "authored",
      type: "chat",
      needs_translation: false,
      source_name: bot.profile.name,
      xuid: "",
      platform_chat_id: "",
      has_filtered_message: false,
      message,
    });
  async function execute(text) {
    command(text);
    await delay(260);
  }
  async function inspect() {
    const offset = diagnostics().length;
    chat("[QA] inspect motion");
    const match = await until(() =>
      diagnostics()
        .slice(offset)
        .match(
          /QA motion state: pos=(\S+) dim=(-?\d+) ground=(true|false) water=(true|false) swim=(true|false) fly=(true|false) glide=(true|false) dead=(true|false) vehicle=(\S+) carrier=(\S+)/,
        ),
    );
    const [pos, carrier] = [match[1], match[10]].map((data) =>
      data.split(",").map(Number),
    );
    return {
      pos,
      dimension: Number(match[2]),
      ground: match[3] === "true",
      water: match[4] === "true",
      swim: match[5] === "true",
      fly: match[6] === "true",
      glide: match[7] === "true",
      dead: match[8] === "true",
      vehicle: match[9],
      carrier,
    };
  }
  async function travel(steps, delta, flags = ["up"]) {
    driver.setPaused(true);
    try {
      for (let i = 0; i < steps; i++) {
        const position = {
          x: driver.position.x + (delta.x ?? 0),
          y: driver.position.y + (delta.y ?? 0),
          z: driver.position.z + (delta.z ?? 0),
        };
        Object.assign(driver.position, position);
        driver.input(undefined, undefined, undefined, {
          position,
          delta: { x: delta.x ?? 0, y: delta.y ?? 0, z: delta.z ?? 0 },
          inputData: flags,
          moveVector: { x: 0, z: flags.includes("up") ? 1 : 0 },
        });
        await delay(54);
      }
    } finally {
      driver.setPaused(false);
    }
  }
  async function modeCase(mode, condition, action) {
    const before = await inspect();
    assert.ok(
      condition(before),
      mode + " native state: " + JSON.stringify(before),
    );
    const previous = values(await query());
    await action();
    const after = await inspect();
    const key = `travel.${mode}_millimeters`;
    await delay(2150);
    const next = values(await query());
    const increments = Object.fromEntries(
      travelKeys.map((metric) => [
        metric,
        Number(next[metric] - previous[metric]),
      ]),
    );
    const start = mode === "vehicle" ? before.carrier : before.pos;
    const end = mode === "vehicle" ? after.carrier : after.pos;
    const observed = Math.hypot(
      end[0] - start[0],
      mode === "walk" ? 0 : end[1] - start[1],
      end[2] - start[2],
    );
    const result = {
      mode,
      before,
      after,
      increments,
      observedMeters: observed,
    };
    console.log(JSON.stringify({ stage: "native-movement-case", ...result }));
    assert.ok(observed > 0.25, mode + " authoritative positions must change");
    assert.ok(increments[key] > 0, mode + " native counters must increase");
    for (const other of travelKeys.filter((metric) => metric !== key))
      assert.equal(
        increments[other],
        0,
        mode + " exclusive classification " + other,
      );
    cases.push(result);
  }

  async function noDistance(name, action) {
    await delay(2250);
    const previous = values(await query());
    const before = await inspect();
    await action();
    const after = await inspect();
    await delay(2250);
    const next = values(await query());
    for (const key of travelKeys)
      assert.equal(next[key], previous[key], name + " " + key);
    const result = { name, before, after };
    console.log(
      JSON.stringify({ stage: "native-movement-exclusion", ...result }),
    );
    cases.push(result);
    return result;
  }

  if (!thresholdOnly) {
    await execute("gamemode creative ArchiveQA");
    await execute("execute in overworld run tp ArchiveQA 45.5 100 0.5");
    bot.queue("serverbound_loading_screen", { type: 2 });
    await execute("fill 40 99 -5 55 99 42 stone");
    await execute("fill 40 100 -5 55 109 42 air");
    await execute("gamemode survival ArchiveQA");
    await execute("tp ArchiveQA 45.5 100 0.5");
    driver.setGrounded(true);
    driver.setView(0, 0);
    await delay(2300);
    await modeCase(
      "walk",
      (s) => !s.fly && !s.swim && !s.glide && s.vehicle === "none",
      () => travel(22, { z: 0.2 }),
    );

    await execute("fill 69 96 -4 85 96 32 stone");
    await execute("fill 69 97 -4 85 104 32 water");
    await execute("tp ArchiveQA 75.5 99.1 0.5");
    driver.setGrounded(false);
    await travel(4, { z: 0.1 }, ["start_swimming", "up", "sprinting"]);
    await delay(2300);
    await modeCase(
      "swim",
      (s) => s.water && !s.fly && s.vehicle === "none",
      () => travel(18, { z: 0.15 }, ["up", "sprinting"]),
    );

    await execute("gamemode creative ArchiveQA");
    driver.setGrounded(false);
    bot.queue("request_ability", {
      ability: "flying",
      value_type: "bool",
      bool_value: true,
      float_val: 0,
    });
    bot.queue("player_action", {
      runtime_entity_id: bot.entityId,
      action: "start_flying",
      position: block,
      result_position: block,
      face: 0,
    });
    driver.input(undefined, undefined, undefined, {
      inputData: ["start_flying"],
    });
    await until(async () => (await inspect()).fly, 7000);
    await execute("tp ArchiveQA 45.5 135 0.5");
    await delay(2350);
    await modeCase(
      "fly",
      (s) => s.fly && !s.glide && s.vehicle === "none",
      () => travel(20, { y: 0.12, z: 0.18 }, ["up", "want_up"]),
    );

    bot.queue("player_action", {
      runtime_entity_id: bot.entityId,
      action: "stop_flying",
      position: block,
      result_position: block,
      face: 0,
    });
    driver.input(undefined, undefined, undefined, {
      inputData: ["stop_flying"],
    });
    await execute("gamemode survival ArchiveQA");
    await execute("replaceitem entity ArchiveQA slot.armor.chest 0 elytra 1");
    await execute("tp ArchiveQA 45.5 200 0.5");
    driver.setGrounded(false);
    bot.queue("player_action", {
      runtime_entity_id: bot.entityId,
      action: "start_glide",
      position: block,
      result_position: block,
      face: 0,
    });
    await travel(4, { y: -0.2, z: 0.15 }, ["start_gliding", "up"]);
    chat("[QA] start native glide");
    await until(async () => (await inspect()).glide, 3000);
    await delay(2300);
    await modeCase(
      "glide",
      (s) => s.glide && !s.fly && s.vehicle === "none",
      () => travel(24, { y: -0.12, z: 0.3 }, ["up"]),
    );

    await execute("gamemode creative ArchiveQA");
    await execute("tp ArchiveQA 45.5 100 0.5");
    driver.setGrounded(true);
    await execute("kill @e[type=minecart]");
    await execute("fill 45 99 -1 45 99 40 redstone_block");
    await execute("fill 45 100 0 45 100 40 golden_rail");
    await execute("summon minecart 45.5 100.2 3.5");
    await execute(
      "ride ArchiveQA start_riding @e[type=minecart,c=1] teleport_rider",
    );
    await delay(2250);
    await modeCase(
      "vehicle",
      (s) => s.vehicle === "minecraft:minecart",
      async () => {
        chat("[QA] push minecart");
        await delay(1450);
      },
    );
    await execute("ride ArchiveQA stop_riding");
    await execute("kill @e[type=minecart]");
    if (probeOnly) {
      const final = values(await query());
      return {
        probeOnly: true,
        cases,
        increments: Object.fromEntries(
          movementKeys.map((key) => [key, String(final[key] - baseline[key])]),
        ),
      };
    }

    await execute("tp ArchiveQA 48.5 100 1.5");
    driver.setGrounded(true);
    const tiny = await noDistance("small native teleport", () =>
      execute("tp ArchiveQA 48.8 100 1.5"),
    );
    assert.ok(Math.abs(tiny.before.pos[0] - tiny.after.pos[0]) > 0.25);
    assert.ok(Math.abs(tiny.before.pos[0] - tiny.after.pos[0]) < 0.5);
    let fixtureZ;
    const jump = await noDistance(
      "unannounced position discontinuity",
      async () => {
        driver.setPaused(true);
        try {
          const offset = diagnostics().length;
          chat("[QA] position discontinuity");
          const applied = await until(() =>
            diagnostics()
              .slice(offset)
              .match(/QA direct position discontinuity sampled: z=([\d.e+-]+)/),
          );
          fixtureZ = Number(applied[1]);
          const state = await inspect();
          Object.assign(driver.position, {
            x: state.pos[0],
            y: state.pos[1],
            z: state.pos[2],
          });
        } finally {
          driver.setPaused(false);
        }
      },
    );
    assert.ok(Math.abs(jump.before.pos[2] - fixtureZ) >= 29);
    jump.fixtureZ = fixtureZ;
    await execute(
      "execute in nether run tickingarea add circle 0 100 0 2 ArchiveMotionNether",
    );
    await delay(1500);
    const preparation = diagnostics().length;
    await execute("execute in nether run fill -3 99 -3 3 107 20 stone");
    await execute("execute in nether run fill -2 100 -2 2 106 19 air");
    assert.doesNotMatch(
      diagnostics().slice(preparation),
      /Cannot place blocks outside of the world/,
    );
    const nether = await noDistance("cross-dimension teleport", async () => {
      await execute("execute in nether run tp ArchiveQA 0.5 100 0.5");
      await until(() => driver.changes.at(-1)?.dimension === 1);
    });
    assert.equal(nether.before.dimension, 0);
    assert.equal(nether.after.dimension, 1);
    const netherBefore = values(await query("minecraft:nether"));
    await modeCase(
      "walk",
      (s) => s.dimension === 1 && !s.fly,
      () => travel(14, { z: 0.2 }),
    );
    const netherAfter = values(await query("minecraft:nether"));
    assert.ok(netherAfter[travelKeys[0]] > netherBefore[travelKeys[0]]);
    await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
    await until(() => driver.changes.at(-1)?.dimension === 0);
    await execute(
      "execute in nether run tickingarea remove ArchiveMotionNether",
    );
  }

  await execute("gamemode creative ArchiveQA");
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  driver.setGrounded(true);
  driver.setView(0, 0);
  await execute("fill -3 99 -3 8 99 3 stone");
  await execute("fill -3 100 -3 8 105 3 air");
  await execute("tp ArchiveQA 0.5 100 0.5");
  await execute("setblock 1 100 0 stone");
  await execute("replaceitem entity ArchiveQA slot.hotbar 0 snowball 1");
  const inventoryBefore = snapshots;
  chat("[QA] sync inventory");
  await until(() => snapshots > inventoryBefore && held?.count === 1);
  bot.queue("player_hotbar", {
    selected_slot: 0,
    window_id: "inventory",
    select_slot: true,
  });

  const nonce = "Activity idle boundary " + randomUUID();
  const beforeChat = (await tool("get_chat_messages", { serverId }))
    .highWatermark;
  chat(nonce);
  const signal = await until(async () => {
    const messages = await tool("get_chat_messages", {
      serverId,
      after: beforeChat,
    });
    return messages.items.find(
      (item) => item.text === nonce && item.source === "PLAYER",
    );
  });
  const chatAt = Date.parse(signal.occurredAt);
  assert.ok(Number.isFinite(chatAt));
  const cutoff = chatAt + idleSeconds * 1000;
  console.log(
    JSON.stringify({
      stage: "waiting-for-native-afk-cutoff",
      chatAt: signal.occurredAt,
      idleSeconds,
    }),
  );
  await until(
    async () => {
      const remaining = cutoff + 3200 - Date.now();
      if (remaining <= 0) return true;
      await delay(Math.min(remaining, 4000));
      return false;
    },
    idleSeconds * 1000 + 20_000,
  );
  const inactive = await query();
  const activeAtCutoff = value(inactive, "activity.millis");
  const onlineAtCutoff = value(inactive, "online.millis");
  const originalBatches = () =>
    readdirSync(cache)
      .filter((file) => file.endsWith(".pending"))
      .map(
        (file) => JSON.parse(readFileSync(path.join(cache, file), "utf8")).body,
      )
      .filter((body) => JSON.parse(body).collector.bootId === bootId);
  const originalMovement = (originals) =>
    originals
      .flatMap((body) => JSON.parse(body).events)
      .filter((event) => movementKeys.includes(event.metric));
  const activeBeforeResume = originalMovement(originalBatches()).filter(
    (event) => event.metric === "activity.millis",
  );
  const lastActiveAt = Math.max(
    ...activeBeforeResume.map((event) => Date.parse(event.at)),
  );
  assert.ok(
    Math.abs(lastActiveAt - (cutoff - 1)) < 75,
    "Last observed active interval must stop at the configured deadline",
  );
  await delay(5700);
  const stillIdle = await query();
  assert.equal(value(stillIdle, "activity.millis"), activeAtCutoff);
  assert.ok(value(stillIdle, "online.millis") > onlineAtCutoff);

  const offset = diagnostics().length;
  driver.input(undefined, undefined, {
    legacy: { legacy_request_id: 0 },
    actions: [],
    data: {
      action_type: "click_air",
      trigger_type: "player_input",
      block_position: block,
      face: 1,
      hotbar_slot: 0,
      hand: "main_hand",
      held_item: held,
      player_pos: { ...driver.position },
      click_pos: { x: 0.5, y: 1, z: 0.5 },
      block_runtime_id: 0,
      client_prediction: "success",
      client_cooldown_state: "off",
    },
  });
  await until(() =>
    diagnostics().slice(offset).includes("QA first snowball use cancelled"),
  );
  await delay(2350);
  assert.equal(
    value(await query(), "activity.millis"),
    activeAtCutoff,
    "Cancelled item use must not reactivate the player",
  );
  await execute("replaceitem entity ArchiveQA slot.hotbar 0 diamond_pickaxe 1");
  const minedBefore = value(await query(), "blocks.mined");
  const target = { x: 1, y: 100, z: 0 };
  driver.input(
    [
      { action: "start_break", position: target, face: 1 },
      { action: "predict_break", position: target, face: 1 },
    ],
    {
      request_id: -401,
      actions: [
        {
          type_id: "mine_block",
          legacy_type_id: 11,
          hotbar_slot: 0,
          predicted_durability: 0,
          network_id: 0,
        },
      ],
      custom_names: [],
      cause: "chat_public",
    },
  );
  await until(async () => {
    const current = await query();
    return (
      value(current, "blocks.mined") === minedBefore + 1n &&
      value(current, "activity.millis") > activeAtCutoff
    );
  });
  console.log(
    JSON.stringify({
      stage: "native-afk-cutoff-verified",
      idleSeconds,
      lastActiveAt,
      cutoff,
      onlineContinued: true,
      cancelledUseIgnored: true,
      realMiningResumedActivity: true,
    }),
  );

  await execute("gamerule doimmediaterespawn false");
  await execute("gamemode survival ArchiveQA");
  await execute("spawnpoint ArchiveQA 7 100 1");
  const respawns = [];
  bot.on("respawn", (packet) => respawns.push(packet));
  const respawnCase = await noDistance("death and native respawn", async () => {
    driver.setPaused(true);
    try {
      await execute("kill ArchiveQA");
      await until(async () => (await inspect()).dead);
      bot.queue("respawn", {
        position: { ...driver.position },
        state: 2,
        runtime_entity_id: bot.entityId,
      });
      await until(() => respawns.some((packet) => packet.state === 1));
      bot.queue("player_action", {
        runtime_entity_id: bot.entityId,
        action: "respawn",
        position: block,
        result_position: block,
        face: 0,
      });
      const state = await until(async () => {
        const current = await inspect();
        return !current.dead && current.pos[0] > 6 ? current : null;
      });
      Object.assign(driver.position, {
        x: state.pos[0],
        y: state.pos[1],
        z: state.pos[2],
      });
    } finally {
      driver.setPaused(false);
    }
  });
  assert.ok(Math.abs(respawnCase.before.pos[0] - respawnCase.after.pos[0]) > 5);
  const final = await query();
  await delay(2250);
  assert.deepEqual(
    values(await query()),
    values(final),
    "Respawn must start without previous life activity",
  );

  const originals = originalBatches();
  const events = originalMovement(originals);
  const ids = new Set(events.map((event) => event.eventId));
  assert.equal(ids.size, events.length);
  const versions = Object.fromEntries(
    movementKeys.map((key) => [
      key,
      key === "activity.millis"
        ? `native-activity-idle-${idleSeconds}s-v1`
        : "native-motion-sample-v1",
    ]),
  );
  const sums = Object.fromEntries(
    movementKeys.map((key) => [
      key,
      events
        .filter((event) => event.metric === key)
        .reduce((total, event) => total + BigInt(event.value), 0n),
    ]),
  );
  const previous = beforeBoot
    ? values(beforeBoot)
    : Object.fromEntries(movementKeys.map((key) => [key, 0n]));
  for (const key of movementKeys) {
    assert.equal(
      value(final, key) - previous[key],
      sums[key],
      key + " raw batch vs MCP",
    );
    if (sums[key] > 0n)
      assert.ok(
        final.metrics
          .find((metric) => metric.key === key)
          .measurements.some(
            (item) =>
              item.quality === "ESTIMATED" &&
              item.algorithmVersion === versions[key],
          ),
      );
  }
  for (const body of originals) {
    const batch = JSON.parse(body);
    for (const event of batch.events.filter((event) =>
      movementKeys.includes(event.metric),
    )) {
      assert.deepEqual(Object.keys(event).sort(), [
        "at",
        "dimension",
        "eventId",
        "kind",
        "metric",
        "player",
        "subject",
        "value",
      ]);
      assert.ok(
        batch.capabilities.some(
          (cap) =>
            cap.metric === event.metric &&
            cap.quality === "ESTIMATED" &&
            cap.algorithmVersion === versions[event.metric] &&
            cap.dimensionAware,
        ),
      );
    }
  }
  const feedIds = new Set();
  let cursor = activityStart;
  for (let page = 0; page < 100; page++) {
    const feed = await tool("get_recent_activity", {
      serverId,
      playerKey,
      after: cursor,
      limit: 200,
    });
    for (const item of feed.items) feedIds.add(item.eventId);
    if (!feed.hasMore) break;
    assert.notEqual(feed.nextCursor, cursor);
    cursor = feed.nextCursor;
    assert.ok(page < 99);
  }
  for (const id of ids)
    assert.ok(
      feedIds.has(id),
      "Original movement record must appear in the MCP feed",
    );
  const replay = await replayBatch(
    originals.find((body) =>
      JSON.parse(body).events.some((event) => ids.has(event.eventId)),
    ),
  );
  assert.equal(replay.duplicateBatch, true);
  assert.equal(replay.acceptedEvents, 0);
  assert.deepEqual(values(await query()), values(final));
  return {
    cases,
    thresholdOnly,
    idleSeconds,
    bootId,
    versions,
    nativeEventCount: events.length,
    increments: Object.fromEntries(
      movementKeys.map((key) => [key, String(sums[key])]),
    ),
    totals: Object.fromEntries(
      movementKeys.map((key) => [key, String(value(final, key))]),
    ),
    cutoff: {
      chatAt: signal.occurredAt,
      lastActiveAt,
      configuredDeadline: cutoff,
      onlineContinued: true,
      cancelledUseIgnored: true,
      miningResumedActivity: true,
      respawnClearedActivity: true,
    },
    originalNativeSumsMatchMcp: true,
    nativeBatchReplayDeduplicated: true,
    coordinateFreeEvents: true,
  };
}
