import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inputDriver } from "./input-driver.mjs";

export async function verifyCrafting({
  bot,
  command,
  until,
  diagnostics,
  tool,
  serverId,
  playerKey,
  cache,
  replayBatch,
}) {
  const inventory = new Map(),
    responses = [],
    updates = new Map(),
    containers = new Map(),
    opened = [];
  let snapshots = 0,
    requestId = -199;
  const driver = inputDriver(bot),
    cases = [],
    expected = { "crafting.crafts": 0, "crafting.items": 0 };
  const key = (p) => `${p.x},${p.y},${p.z}`;
  bot.on("update_block", (p) =>
    updates.set(key(p.position), p.block_runtime_id),
  );
  bot.on("container_open", (p) => opened.push(p));
  bot.on("inventory_slot", (p) => {
    if (["inventory", 0].includes(p.window_id)) inventory.set(p.slot, p.item);
  });
  bot.on("inventory_content", (p) => {
    if (["inventory", 0].includes(p.window_id)) {
      p.input.forEach((item, slot) => inventory.set(slot, item));
      snapshots++;
    }
  });
  bot.on("item_stack_response", (p) => {
    responses.push(...p.responses);
    for (const r of p.responses)
      for (const c of r.containers ?? [])
        for (const s of c.slots)
          containers.set(`${c.slot_type.container_id}:${s.slot}`, s);
  });
  const query = (dimension) =>
    tool("get_player_statistics", {
      serverId,
      playerKey,
      ...(dimension ? { dimension } : {}),
    });
  const values = (data) =>
    Object.fromEntries(
      Object.keys(expected).map((key) => [
        key,
        BigInt(data.metrics.find((m) => m.key === key)?.value ?? "0"),
      ]),
    );
  const baseline = values(await query()),
    begin = (await tool("get_recent_activity", { serverId })).highWatermark;
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
  async function execute(text) {
    command(text);
    await delay(200);
  }
  async function sync() {
    const before = snapshots;
    chat("[QA] sync inventory");
    await until(() => snapshots > before);
  }
  async function give(type, count = 1, slot = 0) {
    await execute(
      `replaceitem entity ArchiveQA slot.hotbar ${slot} ${type} ${count}`,
    );
    await sync();
    assert.equal(inventory.get(slot).count, count);
  }
  async function clear() {
    await execute("clear ArchiveQA");
    await sync();
  }
  async function check(name, crafts = 0, items = 0) {
    expected["crafting.crafts"] += crafts;
    expected["crafting.items"] += items;
    await delay(800);
    await until(async () => {
      const actual = values(await query());
      return Object.keys(expected).every(
        (key) => actual[key] - baseline[key] === BigInt(expected[key]),
      );
    });
    cases.push({ name, crafts, items });
    console.log(JSON.stringify({ stage: name, ...expected }));
  }
  const slot = (container, slot, stack_id = 0) => ({
    slot_type: { container_id: container },
    slot,
    stack_id,
  });
  const input = (index = 0) =>
    slot("hotbar_and_inventory", index, inventory.get(index)?.stack_id ?? 0);
  const take = (count, id, dest = 1) => ({
    type_id: "take",
    legacy_type_id: 0,
    count,
    source: slot("creative_output", 50, id),
    destination: slot(
      "hotbar_and_inventory",
      dest,
      inventory.get(dest)?.stack_id ?? 0,
    ),
  });
  function auto(recipe, times = 1) {
    return {
      type_id: "craft_recipe_auto",
      legacy_type_id: 13,
      recipe_network_id: recipe.network_id,
      times_crafted: times,
      ingredients: recipe.input
        .filter((i) => i.type === "valid")
        .map((i) => ({
          type: i.descriptor_type,
          legacy_type:
            i.descriptor_type === "name"
              ? 1
              : i.descriptor_type === "item_tag"
                ? 3
                : 2,
          name: i.name,
          tag: i.tag,
          expression: i.expression,
          metadata: i.metadata,
          count: i.count,
        })),
    };
  }
  const consume = (count, source = input()) => ({
    type_id: "consume",
    legacy_type_id: 5,
    count,
    source,
  });
  async function send(build, success = true) {
    // The server distinguishes stack request IDs from legacy IDs by the low bit.
    const id = (requestId -= 2),
      offset = diagnostics().length;
    const request = {
      request_id: id,
      actions: build(id),
      custom_names: [],
      cause: "chat_public",
    };
    bot.queue("item_stack_request", { requests: [request] });
    const response = await until(() =>
      responses.find((r) => r.request_id === id),
    );
    await sync();
    const trace = diagnostics()
      .slice(offset)
      .split(/\r?\n/)
      .filter((l) => l.includes("QA craft") || l.includes("QA stack"));
    console.log(
      JSON.stringify({
        stage: "native-crafting-request",
        id,
        status: response.status,
        trace,
      }),
    );
    if (success) assert.equal(response.status, "ok", JSON.stringify(response));
    else assert.notEqual(response.status, "ok");
    return { response, trace };
  }
  async function openInventory() {
    bot.queue("interact", {
      action_id: "open_inventory",
      target_entity_id: bot.entityId,
      has_position: false,
    });
    await delay(250);
  }
  async function close(window = 0) {
    bot.queue("container_close", {
      window_id: window,
      window_type: "inventory",
      server: false,
    });
    await delay(250);
  }
  await execute("gamemode creative ArchiveQA");
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  driver.setGrounded(true);
  await execute("fill -3 99 -3 5 99 6 bedrock");
  await execute("fill -3 100 -3 5 106 6 air");
  await clear();
  await execute("gamemode survival ArchiveQA");
  chat("[QA] enable crafting diagnostics");
  await until(() => diagnostics().includes("QA crafting diagnostics enabled"));
  await until(() => bot.archiveQaCraftingPackets.length > 0);
  const all = bot.archiveQaCraftingPackets.flatMap((p) => [
      ...(p.shapeless_recipes ?? []),
      ...(p.shaped_recipes ?? []),
    ]),
    recipe = (id) => {
      const r = all.find((r) => r.recipe_id === id);
      assert.ok(r, `Actual server recipe ${id}`);
      return r;
    };
  const planks = recipe("minecraft:oak_planks");
  await give("oak_log", 8);
  await check("console-given-materials-are-not-crafting");
  await openInventory();
  await check("opening-inventory-is-not-crafting");
  await send(() => [auto(planks)], false);
  await check("recipe-selection-without-consumption-is-not-crafting");
  await send(
    (id) => [
      { ...auto(planks), recipe_network_id: 99999999 },
      consume(1),
      take(4, id),
    ],
    false,
  );
  await check("unknown-recipe-is-not-crafting");
  await send((id) => [auto(planks), consume(1), take(4, id)]);
  assert.equal(inventory.get(0).count, 7);
  assert.equal(inventory.get(1).count, 4);
  assert.equal(inventory.get(1).network_id, planks.output[0].network_id);
  await check("actual-personal-recipe-book-craft", 1, 4);
  await send((id) => [auto(planks, 3), consume(3), take(12, id)]);
  assert.equal(inventory.get(0).count, 4);
  assert.equal(inventory.get(1).count, 16);
  await check("three-recipes-produce-twelve-items", 3, 12);
  let result = await send(
    (id) => [auto(planks), consume(1), take(63, id)],
    false,
  );
  assert.ok(
    result.trace.some((l) => l.includes("QA craft init results: status=0")),
  );
  assert.equal(inventory.get(0).count, 4);
  assert.equal(inventory.get(1).count, 16);
  await check("failure-after-output-initialization-rolls-back");
  let offset = diagnostics().length;
  chat("[QA] fail next crafting commit");
  await until(() =>
    diagnostics().slice(offset).includes("QA crafting commit failure armed"),
  );
  result = await send((id) => [auto(planks), consume(1), take(4, id)], false);
  assert.ok(
    result.trace.some((l) =>
      l.includes("QA crafting commit rejected before origin"),
    ),
  );
  assert.ok(
    result.trace.some((l) => l.includes("QA craft init results: status=0")),
  );
  assert.equal(inventory.get(0).count, 4);
  assert.equal(inventory.get(1).count, 16);
  await check("final-inventory-commit-failure-is-not-counted");
  if (process.argv.includes("--probe-crafting"))
    return { probeOnly: true, cases };
  await send(() => [
    {
      type_id: "take",
      legacy_type_id: 0,
      count: 1,
      source: input(),
      destination: slot("crafting_input", 28),
    },
  ]);
  await check("moving-material-into-grid-is-not-crafting");
  let grid = containers.get("crafting_input:28");
  assert.equal(grid.count, 1);
  await send((id) => [
    {
      type_id: "craft_recipe",
      legacy_type_id: 12,
      recipe_network_id: planks.network_id,
      times_crafted: 1,
    },
    consume(1, slot("crafting_input", 28, grid.item_stack_id)),
    take(4, id),
  ]);
  assert.equal(inventory.get(0).count, 3);
  assert.equal(inventory.get(1).count, 20);
  await check("actual-personal-grid-craft", 1, 4);
  await clear();
  await give("dirt", 2);
  await send((id) => [auto(planks), consume(1), take(4, id)], false);
  assert.equal(inventory.get(0).count, 2);
  await check("wrong-material-is-not-crafting");
  await clear();
  await give("oak_log", 1);
  await send((id) => [auto(planks, 2), consume(2), take(8, id)], false);
  assert.equal(inventory.get(0).count, 1);
  await check("insufficient-materials-are-not-crafting");
  await clear();
  await give("honey_bottle", 2);
  const honey = recipe("minecraft:honey_bottle_to_sugar");
  await send((id) => [
    auto(honey, 2),
    consume(2),
    { type_id: "create", legacy_type_id: 6, result_slot_id: 0 },
    take(6, id),
    { type_id: "create", legacy_type_id: 6, result_slot_id: 1 },
    take(2, id, 2),
  ]);
  assert.equal(inventory.get(1).network_id, honey.output[0].network_id);
  assert.equal(inventory.get(1).count, 6);
  assert.equal(inventory.get(2).network_id, honey.output[1].network_id);
  assert.equal(inventory.get(2).count, 2);
  await check("batch-multiple-outputs-including-returned-bottles", 2, 8);
  await close();
  await execute("gamemode creative ArchiveQA");
  await openInventory();
  await clear();
  await give("oak_log", 1);
  await send((id) => [auto(planks), consume(1), take(4, id)]);
  assert.equal(inventory.get(1).count, 4);
  await check("creative-player-material-crafting", 1, 4);
  await clear();
  const creative = bot.archiveQaCreativeContent?.find(
    (entry) => entry.item.network_id === planks.output[0].network_id,
  );
  assert.ok(creative);
  await send((id) => [
    {
      type_id: "craft_creative",
      legacy_type_id: 14,
      item_id: creative.entry_id,
      times_crafted: 1,
    },
    take(4, id),
  ]);
  assert.equal(inventory.get(1).network_id, planks.output[0].network_id);
  await check("creative-menu-items-are-not-recipe-crafting");
  await close();
  await execute("gamemode survival ArchiveQA");
  await clear();
  await execute("give ArchiveQA stone 2304");
  await sync();
  assert.equal(
    [...inventory].filter(([, item]) => item.count === 64).length,
    36,
  );
  await give("oak_log", 2);
  await openInventory();
  await send((id) => [auto(planks), consume(1), take(4, id)], false);
  assert.equal(inventory.get(0).count, 2);
  assert.equal(inventory.get(1).count, 64);
  await check("full-inventory-rollback-does-not-count");
  await close();
  await clear();
  await execute("setblock 1 100 1 crafting_table");
  await until(() => updates.get("1,100,1"));
  bot.queue("player_hotbar", {
    selected_slot: 0,
    window_id: "inventory",
    select_slot: true,
  });
  const openBefore = opened.length;
  driver.input(undefined, undefined, {
    legacy: { legacy_request_id: 0 },
    actions: [],
    data: {
      action_type: "click_block",
      trigger_type: "player_input",
      block_position: { x: 1, y: 100, z: 1 },
      face: 1,
      hotbar_slot: 0,
      hand: "main_hand",
      held_item: inventory.get(0),
      player_pos: { ...driver.position },
      click_pos: { x: 0.5, y: 1, z: 0.5 },
      block_runtime_id: updates.get("1,100,1"),
      client_prediction: "success",
      client_cooldown_state: "off",
    },
  });
  const workbench = await until(() =>
    opened.slice(openBefore).find((p) => p.window_type === "workbench"),
  );
  await check("opening-workbench-is-not-crafting");
  const bread = recipe("minecraft:bread");
  await give("wheat", 9);
  await send((id) => [auto(bread, 2), consume(6), take(2, id)]);
  assert.equal(inventory.get(0).count, 3);
  assert.equal(inventory.get(1).count, 2);
  await check("actual-workbench-batch-craft", 2, 2);
  for (const position of [32, 33, 34])
    await send(() => [
      {
        type_id: "take",
        legacy_type_id: 0,
        count: 1,
        source: input(),
        destination: slot("crafting_input", position),
      },
    ]);
  await check("placing-workbench-grid-materials-is-not-crafting");
  await send((id) => [
    {
      type_id: "craft_recipe",
      legacy_type_id: 12,
      recipe_network_id: bread.network_id,
      times_crafted: 1,
    },
    ...[32, 33, 34].map((position) =>
      consume(
        1,
        slot(
          "crafting_input",
          position,
          containers.get(`crafting_input:${position}`).item_stack_id,
        ),
      ),
    ),
    take(1, id),
  ]);
  assert.equal(inventory.get(1).count, 3);
  await check("actual-workbench-manual-grid-craft", 1, 1);
  await close(workbench.window_id);
  await clear();
  await give("bread", 5);
  await check("console-given-products-are-not-crafting");
  const netherBefore = values(await query("minecraft:nether")),
    overworldBefore = values(await query("minecraft:overworld"));
  await execute("execute in nether run tp ArchiveQA 0.5 100 0.5");
  await until(() => driver.changes.at(-1)?.dimension === 1);
  await execute("execute in nether run fill -3 99 -3 5 99 6 bedrock");
  await execute("execute in nether run fill -3 100 -3 5 106 6 air");
  await clear();
  await give("oak_log", 1);
  await openInventory();
  await send((id) => [auto(planks), consume(1), take(4, id)]);
  assert.equal(inventory.get(1).count, 4);
  await check("actual-nether-craft-has-nether-dimension", 1, 4);
  const netherAfter = values(await query("minecraft:nether"));
  assert.equal(
    netherAfter["crafting.crafts"] - netherBefore["crafting.crafts"],
    1n,
  );
  assert.equal(
    netherAfter["crafting.items"] - netherBefore["crafting.items"],
    4n,
  );
  assert.deepEqual(values(await query("minecraft:overworld")), overworldBefore);
  await close();
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  await until(() => driver.changes.at(-1)?.dimension === 0);
  const final = await query(),
    activity = [];
  let cursor = begin;
  for (let page = 0; page < 100; page++) {
    const data = await tool("get_recent_activity", {
      serverId,
      playerKey,
      after: cursor,
      limit: 200,
    });
    activity.push(...data.items);
    if (!data.hasMore) break;
    assert.notEqual(data.nextCursor, cursor);
    cursor = data.nextCursor;
    assert.ok(page < 99);
  }
  const events = activity.filter((e) => Object.hasOwn(expected, e.metric)),
    ids = new Set(events.map((e) => e.eventId));
  assert.equal(ids.size, events.length);
  const original = readdirSync(cache)
      .filter((n) => n.endsWith(".pending"))
      .map((n) => JSON.parse(readFileSync(path.join(cache, n), "utf8")).body),
    native = original
      .flatMap((b) => JSON.parse(b).events)
      .filter((e) => ids.has(e.eventId));
  assert.equal(native.length, events.length);
  for (const key of Object.keys(expected))
    assert.equal(
      native
        .filter((e) => e.metric === key)
        .reduce((sum, e) => sum + Number(e.value), 0),
      expected[key],
    );
  const subjects = Object.fromEntries(
    Object.keys(expected).map((key) => [
      key,
      Object.fromEntries(
        [
          ...new Set(
            native.filter((e) => e.metric === key).map((e) => e.subject),
          ),
        ].map((subject) => [
          subject,
          native
            .filter((e) => e.metric === key && e.subject === subject)
            .reduce((sum, e) => sum + Number(e.value), 0),
        ]),
      ),
    ]),
  );
  for (const key of Object.keys(expected))
    assert.ok(
      final.metrics
        .find((m) => m.key === key)
        .measurements.some(
          (m) =>
            m.quality === "EXACT" &&
            m.algorithmVersion === "native-crafting-commit-v1",
        ),
    );
  const replay = await replayBatch(
    original.find((b) => JSON.parse(b).events.some((e) => ids.has(e.eventId))),
  );
  assert.equal(replay.duplicateBatch, true);
  assert.equal(replay.acceptedEvents, 0);
  assert.deepEqual(values(await query()), values(final));
  return {
    cases,
    increments: expected,
    totals: Object.fromEntries(
      Object.entries(values(final)).map(([key, value]) => [key, String(value)]),
    ),
    originalNativeSubjects: subjects,
    originalNativeSumsMatchMcp: true,
    nativeBatchReplayDeduplicated: true,
    finalCommitRollbackVerified: true,
    actualInventoryOutputsVerified: true,
    quality: "EXACT",
    algorithmVersion: "native-crafting-commit-v1",
  };
}
