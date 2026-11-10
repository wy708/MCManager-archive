import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { inputDriver } from "./input-driver.mjs";
import { localGameClient } from "./http-client.mjs";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export async function verifyBreeding({
  bot,
  command,
  until,
  diagnostics,
  tool,
  serverId,
  playerKey,
}) {
  if (!process.argv.includes("--probe-breeding"))
    return verifyBreedingAcceptance(arguments[0]);
  const actors = [],
    inventory = new Map();
  let snapshots = 0;
  const driver = inputDriver(bot);
  bot.on("add_entity", (packet) => actors.push(packet));
  bot.on("inventory_slot", (packet) => {
    if (["inventory", 0].includes(packet.window_id))
      inventory.set(packet.slot, packet.item);
  });
  bot.on("inventory_content", (packet) => {
    if (["inventory", 0].includes(packet.window_id)) {
      packet.input.forEach((item, slot) => inventory.set(slot, item));
      snapshots++;
    }
  });
  async function execute(text) {
    command(text);
    await delay(250);
  }
  function chat(message) {
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
  }
  async function equip(type, count = 16) {
    await execute(
      `replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`,
    );
    const before = snapshots;
    chat("[QA] sync inventory");
    await until(() => snapshots > before);
    bot.queue("player_hotbar", {
      selected_slot: 0,
      window_id: "inventory",
      select_slot: true,
    });
    await delay(200);
  }
  function feed(target) {
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use_on_entity",
        actions: [],
        transaction_data: {
          entity_runtime_id: target.runtime_id,
          action_type: "interact",
          hotbar_slot: 0,
          held_item: inventory.get(0),
          player_pos: { ...driver.position },
          click_pos: { x: 0, y: 1, z: 0 },
        },
      },
    });
  }
  await execute("gamemode creative ArchiveQA");
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  driver.setGrounded(true);
  await execute("fill -5 99 -5 8 99 8 bedrock");
  await execute("fill -5 100 -5 8 106 8 air");
  await execute("gamerule domobspawning false");
  await execute("difficulty peaceful");
  await execute("kill @e[type=cow]");
  await execute("clear ArchiveQA");
  await execute("effect ArchiveQA clear");
  chat("[QA] enable breeding diagnostics");
  await until(() => diagnostics().includes("QA breeding diagnostics enabled"));
  async function cow(x) {
    const before = actors.length;
    await execute(`summon cow ${x} 100 2.5`);
    const target = await until(() =>
      actors
        .slice(before)
        .find((actor) => actor.entity_type === "minecraft:cow"),
    );
    const offset = diagnostics().length;
    chat("[QA] inspect actor " + target.unique_id);
    await until(() =>
      diagnostics().slice(offset).includes("QA actor geometry:"),
    );
    assert.ok(
      diagnostics().slice(offset).includes("baby=false"),
      "The actual parent must be an adult",
    );
    return target;
  }
  const first = await cow(0.5),
    second = await cow(1.5);
  await execute("gamemode survival ArchiveQA");
  await equip("wheat");
  const offset = diagnostics().length;
  feed(first);
  await delay(700);
  await equip("wheat");
  feed(second);
  await until(() => diagnostics().slice(offset).includes("QA mate returned:"));
  await delay(800);
  console.log(
    JSON.stringify({
      stage: "actual-cow-breeding-diagnostic",
      newActors: actors
        .slice(2)
        .map((actor) => ({
          type: actor.entity_type,
          id: String(actor.unique_id),
        })),
      trace: diagnostics()
        .slice(offset)
        .split(/\r?\n/)
        .filter((line) => line.includes("QA mate")),
    }),
  );
  return { probeOnly: true };
}

async function verifyBreedingAcceptance({
  bot,
  command,
  until,
  diagnostics,
  tool,
  serverId,
  playerKey,
  cache,
  replayBatch,
  reconnect,
}) {
  const actors = [],
    inventory = new Map(),
    cases = [];
  let snapshots = 0,
    driver = inputDriver(bot),
    expected = 0;
  function watch(client) {
    client.on("add_entity", (packet) => actors.push(packet));
    client.on("inventory_slot", (packet) => {
      if (["inventory", 0].includes(packet.window_id))
        inventory.set(packet.slot, packet.item);
    });
    client.on("inventory_content", (packet) => {
      if (["inventory", 0].includes(packet.window_id)) {
        packet.input.forEach((item, slot) => inventory.set(slot, item));
        snapshots++;
      }
    });
  }
  watch(bot);
  function chat(message, client = bot) {
    client.queue("text", {
      category: "authored",
      type: "chat",
      needs_translation: false,
      source_name: client.profile.name,
      xuid: "",
      platform_chat_id: "",
      has_filtered_message: false,
      message,
    });
  }
  async function execute(text) {
    command(text);
    await delay(250);
  }
  async function sync() {
    const before = snapshots;
    chat("[QA] sync inventory");
    await until(() => snapshots > before);
  }
  async function equip(type, count = 16) {
    await execute(
      `replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`,
    );
    await sync();
    bot.queue("player_hotbar", {
      selected_slot: 0,
      window_id: "inventory",
      select_slot: true,
    });
    await delay(200);
  }
  function feed(target, client = bot, hand = inventory.get(0), input = driver) {
    client.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use_on_entity",
        actions: [],
        transaction_data: {
          entity_runtime_id: target.runtime_id,
          action_type: "interact",
          hotbar_slot: 0,
          held_item: hand,
          player_pos: { ...input.position },
          click_pos: { x: 0, y: 1, z: 0 },
        },
      },
    });
  }
  async function state(target) {
    const offset = diagnostics().length;
    chat("[QA] inspect breeding " + target.unique_id);
    const match = await until(() =>
      diagnostics()
        .slice(offset)
        .match(
          new RegExp(
            `QA breeding state: id=${target.unique_id} baby=(true|false) loveCause=(-?\\d+) loveTimer=(-?\\d+) cooldown=(-?\\d+)`,
          ),
        ),
    );
    return {
      baby: match[1] === "true",
      cause: match[2],
      timer: Number(match[3]),
      cooldown: Number(match[4]),
    };
  }
  const query = (dimension) =>
      tool("get_player_statistics", {
        serverId,
        playerKey,
        ...(dimension ? { dimension } : {}),
      }),
    value = (data) =>
      BigInt(
        data.metrics.find((metric) => metric.key === "breeding.offspring")
          ?.value ?? "0",
      );
  async function check(name, increment = 0) {
    expected += increment;
    await delay(700);
    await until(
      async () => value(await query()) - initial === BigInt(expected),
    );
    cases.push({ name, increment });
    console.log(JSON.stringify({ stage: name, offspring: expected }));
  }
  async function preparePlayer() {
    driver.setGrounded(true);
    await execute("gamemode survival ArchiveQA");
    await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
    bot.queue("serverbound_loading_screen", { type: 2 });
  }
  async function parents(type, dimension) {
    await execute(
      `${dimension ? "execute in " + dimension + " run " : ""}kill @e[type=${type}]`,
    );
    const result = [];
    for (const x of [0.5, 1.5]) {
      let adult;
      for (let attempt = 0; attempt < 12; attempt++) {
        const before = actors.length;
        await execute(
          `${dimension ? "execute in " + dimension + " run " : ""}summon ${type} ${x} 100 2.5`,
        );
        const target = await until(() =>
          actors
            .slice(before)
            .find((actor) => actor.entity_type === "minecraft:" + type),
        );
        if (!(await state(target)).baby) {
          adult = target;
          break;
        }
        const offset = diagnostics().length;
        chat("[QA] remove baby " + target.unique_id);
        await until(() =>
          diagnostics().slice(offset).includes("QA unselected baby removed:"),
        );
      }
      assert.ok(adult, "The actual parent must be an adult");
      result.push(adult);
    }
    return result;
  }
  async function feedPair(pair, item) {
    await equip(item);
    feed(pair[0]);
    await delay(300);
    await sync();
    feed(pair[1]);
    await delay(300);
    await sync();
  }
  async function newBirth(pair, offset) {
    const found = await until(() =>
      diagnostics()
        .slice(offset)
        .match(
          /QA mate result entity: id=(-?\d+) type=([^ ]+) baby=true dead=false actualWorld=true/,
        ),
    );
    assert.ok(!pair.some((actor) => String(actor.unique_id) === found[1]));
    return { id: found[1], type: found[2] };
  }
  await execute("gamemode creative ArchiveQA");
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  driver.setGrounded(true);
  await execute("fill -5 99 -5 8 99 8 bedrock");
  await execute("fill -5 100 -5 8 106 8 air");
  await execute("gamerule domobspawning false");
  await execute("difficulty peaceful");
  await execute("clear ArchiveQA");
  await execute("effect ArchiveQA clear");
  await execute("tickingarea add circle 0 100 2 2 ArchiveBreedingQA true");
  await preparePlayer();
  chat("[QA] enable breeding diagnostics");
  await until(() => diagnostics().includes("QA breeding diagnostics enabled"));
  const initial = value(await query()),
    begin = (await tool("get_recent_activity", { serverId })).highWatermark;
  let pair = await parents("cow");
  await check("spawning-two-adults-is-not-breeding");
  await equip("diamond");
  feed(pair[0]);
  await delay(400);
  assert.equal((await state(pair[0])).timer, 0);
  await check("wrong-feed-does-not-breed");
  await equip("wheat");
  feed(pair[0]);
  await delay(300);
  await sync();
  assert.ok((await state(pair[0])).timer > 0);
  assert.equal(inventory.get(0).count, 15);
  await check("feeding-one-parent-is-not-a-birth");
  feed(pair[0]);
  await delay(300);
  await sync();
  await check("repeat-feed-before-mating-is-not-a-birth");
  let offset = diagnostics().length;
  feed(pair[1]);
  await delay(300);
  await sync();
  const firstBirth = await newBirth(pair, offset);
  await check("actual-cow-offspring", 1);
  assert.ok((await state(pair[0])).cooldown > 0);
  feed(pair[0]);
  await delay(300);
  await sync();
  feed(pair[1]);
  await check("parent-cooldown-does-not-create-another-birth");
  const child = await until(() =>
    actors.find((actor) => String(actor.unique_id) === firstBirth.id),
  );
  await sync();
  feed(child);
  await check("feeding-newborn-growth-is-not-another-birth");
  pair = await parents("cow");
  await equip("wheat");
  offset = diagnostics().length;
  chat("[QA] cancel feeding on");
  await until(() =>
    diagnostics().slice(offset).includes("QA feeding cancellation=true"),
  );
  feed(pair[0]);
  await delay(300);
  feed(pair[1]);
  await until(
    () =>
      diagnostics().slice(offset).split("QA animal feeding cancelled:")
        .length === 3,
  );
  await sync();
  assert.equal(inventory.get(0).count, 16);
  assert.equal((await state(pair[0])).timer, 0);
  assert.equal((await state(pair[1])).timer, 0);
  await check("plugin-cancelled-feeding-does-not-breed");
  chat("[QA] cancel feeding off");
  await delay(200);
  offset = diagnostics().length;
  chat("[QA] cancel mating on");
  await until(() =>
    diagnostics().slice(offset).includes("QA mating cancellation=true"),
  );
  await feedPair(pair, "wheat");
  await until(() =>
    diagnostics().slice(offset).includes("QA mating cancelled:"),
  );
  assert.equal(
    diagnostics().slice(offset).includes("QA mate result entity:"),
    false,
  );
  await check("plugin-cancelled-mating-has-no-offspring");
  await execute("kill @e[type=cow]");
  chat("[QA] cancel mating off");
  await delay(200);
  for (const [type, item] of [
    ["pig", "carrot"],
    ["sheep", "wheat"],
    ["chicken", "wheat_seeds"],
  ]) {
    pair = await parents(type);
    offset = diagnostics().length;
    await feedPair(pair, item);
    const born = await newBirth(pair, offset);
    assert.equal(born.type, "minecraft:" + type);
    await check("actual-" + type + "-offspring", 1);
  }
  pair = await parents("cow");
  offset = diagnostics().length;
  chat("[QA] duplicate next birth result");
  await until(() =>
    diagnostics().slice(offset).includes("QA birth result duplication armed"),
  );
  await feedPair(pair, "wheat");
  await newBirth(pair, offset);
  await until(() =>
    diagnostics().slice(offset).includes("QA birth result duplicated: refs=3"),
  );
  await check("duplicate-native-result-references-count-one-offspring", 1);
  const beforeCommand = actors.length;
  await execute("summon cow 3.5 100 2.5 0 0 minecraft:entity_born");
  const commandBaby = await until(() =>
    actors
      .slice(beforeCommand)
      .find((actor) => actor.entity_type === "minecraft:cow"),
  );
  assert.equal((await state(commandBaby)).baby, true);
  await check("command-spawned-baby-is-not-player-breeding");
  let other,
    otherClosed = false,
    otherError,
    otherKey;
  try {
    other = await localGameClient(
      "http://127.0.0.1:19152",
      "ArchiveVictimQA",
      (error) => {
        if (!otherClosed) otherError = error;
      },
    );
    let spawned = false,
      otherSnapshots = 0;
    const otherInventory = new Map();
    other.on("spawn", () => {
      spawned = true;
    });
    other.on("inventory_content", (packet) => {
      if (["inventory", 0].includes(packet.window_id)) {
        packet.input.forEach((item, slot) => otherInventory.set(slot, item));
        otherSnapshots++;
      }
    });
    await until(() => {
      if (otherError) throw otherError;
      return spawned;
    }, 45_000);
    other.queue("serverbound_loading_screen", { type: 2 });
    const otherDriver = inputDriver(other);
    otherDriver.setGrounded(true);
    otherKey = "uuid:" + other.profile.uuid.toLowerCase();
    const otherBefore = value(
      await tool("get_player_statistics", { serverId, playerKey: otherKey }),
    );
    await execute("gamemode survival ArchiveVictimQA");
    await execute("tp ArchiveVictimQA 1.5 100 0.5");
    other.queue("serverbound_loading_screen", { type: 2 });
    pair = await parents("cow");
    await equip("wheat");
    feed(pair[0]);
    await delay(300);
    await execute("replaceitem entity ArchiveVictimQA slot.hotbar 0 wheat 16");
    const before = otherSnapshots;
    chat("[QA] sync inventory", other);
    await until(() => otherSnapshots > before);
    other.queue("player_hotbar", {
      selected_slot: 0,
      window_id: "inventory",
      select_slot: true,
    });
    await delay(200);
    offset = diagnostics().length;
    feed(pair[1], other, otherInventory.get(0), otherDriver);
    await newBirth(pair, offset);
    await check("different-player-parents-do-not-double-assign-offspring");
    assert.equal(
      value(
        await tool("get_player_statistics", { serverId, playerKey: otherKey }),
      ),
      otherBefore,
    );
  } finally {
    otherClosed = true;
    other?.close();
  }
  pair = await parents("cow");
  offset = diagnostics().length;
  await feedPair(pair, "wheat");
  assert.equal(
    diagnostics().slice(offset).includes("QA mate result entity:"),
    false,
  );
  bot = await reconnect(async () => {
    await until(() =>
      diagnostics().slice(offset).includes("QA mate result entity:"),
    );
    const trace = diagnostics().slice(offset);
    assert.ok(
      trace.indexOf("Player disconnected: ArchiveQA") >= 0 &&
        trace.indexOf("QA mate result entity:") >
          trace.indexOf("Player disconnected: ArchiveQA"),
    );
    await check("actual-offspring-after-feeding-player-disconnected", 1);
  });
  driver = inputDriver(bot);
  watch(bot);
  await preparePlayer();
  const netherBefore = value(await query("minecraft:nether")),
    overworldBefore = value(await query("minecraft:overworld"));
  await execute("execute in nether run tp ArchiveQA 0.5 100 0.5");
  await until(() => driver.changes.at(-1)?.dimension === 1);
  await execute("execute in nether run fill -3 99 -3 5 99 6 bedrock");
  await execute("execute in nether run fill -3 100 -3 5 106 6 air");
  pair = await parents("pig", "nether");
  offset = diagnostics().length;
  await feedPair(pair, "carrot");
  await newBirth(pair, offset);
  await check("actual-nether-offspring-uses-child-dimension", 1);
  assert.equal(value(await query("minecraft:nether")) - netherBefore, 1n);
  assert.equal(value(await query("minecraft:overworld")), overworldBefore);
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  await until(() => driver.changes.at(-1)?.dimension === 0);
  await execute("tickingarea remove ArchiveBreedingQA");
  const final = await query(),
    activity = [];
  let cursor = begin;
  for (let page = 0; page < 100; page++) {
    const result = await tool("get_recent_activity", {
      serverId,
      playerKey,
      after: cursor,
      limit: 200,
    });
    activity.push(...result.items);
    if (!result.hasMore) break;
    assert.notEqual(result.nextCursor, cursor);
    cursor = result.nextCursor;
    assert.ok(page < 99);
  }
  const events = activity.filter(
      (event) => event.metric === "breeding.offspring",
    ),
    ids = new Set(events.map((event) => event.eventId));
  assert.equal(events.length, 7);
  assert.equal(ids.size, 7);
  const original = readdirSync(cache)
      .filter((name) => name.endsWith(".pending"))
      .map(
        (name) => JSON.parse(readFileSync(path.join(cache, name), "utf8")).body,
      ),
    native = original
      .flatMap((body) => JSON.parse(body).events)
      .filter((event) => ids.has(event.eventId));
  assert.equal(native.length, 7);
  const subjects = Object.fromEntries(
    [...new Set(native.map((event) => event.subject))].map((subject) => [
      subject,
      native
        .filter((event) => event.subject === subject)
        .reduce((sum, event) => sum + Number(event.value), 0),
    ]),
  );
  assert.deepEqual(subjects, {
    "minecraft:cow": 3,
    "minecraft:pig": 2,
    "minecraft:sheep": 1,
    "minecraft:chicken": 1,
  });
  assert.equal(
    native.filter((event) => event.dimension === "minecraft:nether").length,
    1,
  );
  assert.equal(
    native.filter((event) => event.dimension === "minecraft:overworld").length,
    6,
  );
  assert.ok(
    final.metrics
      .find((metric) => metric.key === "breeding.offspring")
      .measurements.some(
        (item) =>
          item.quality === "EXACT" &&
          item.algorithmVersion === "native-breeding-result-v1",
      ),
  );
  const replay = await replayBatch(
    original.find((body) =>
      JSON.parse(body).events.some((event) => ids.has(event.eventId)),
    ),
  );
  assert.equal(replay.duplicateBatch, true);
  assert.equal(replay.acceptedEvents, 0);
  assert.equal(value(await query()), value(final));
  return {
    cases,
    increments: { "breeding.offspring": 7 },
    originalNativeSubjects: { "breeding.offspring": subjects },
    originalNativeSumsMatchMcp: true,
    nativeBatchReplayDeduplicated: true,
    totals: { "breeding.offspring": value(final).toString() },
    quality: "EXACT",
    algorithmVersion: "native-breeding-result-v1",
    actualPlayerPairAttribution: true,
    ambiguousPlayersNotDuplicated: true,
    offlineFeedingIdentityRetained: true,
    netherChildDimensionVerified: true,
    otherPlayerKey: otherKey,
  };
}
