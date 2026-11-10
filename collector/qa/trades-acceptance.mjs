import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inputDriver } from "./input-driver.mjs";
const require = createRequire(import.meta.url),
  nbt = require("prismarine-nbt");
export async function verifyTradeAcceptance({
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
    actors = [],
    offers = [],
    responses = [],
    containers = new Map(),
    cases = [],
    successes = [];
  let snapshots = 0,
    requestId = -399;
  const driver = inputDriver(bot),
    expected = { "villager.trades": 0, "villager.items": 0 };
  bot.on("add_entity", (p) => actors.push(p));
  bot.on("update_trade", (p) =>
    offers.push({ ...p, offerData: nbt.simplify(p.offers) }),
  );
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
  const stringify = (v) =>
    JSON.stringify(v, (_, v) => (typeof v === "bigint" ? String(v) : v));
  const query = (dimension) =>
    tool("get_player_statistics", {
      serverId,
      playerKey,
      ...(dimension ? { dimension } : {}),
    });
  const values = (data) =>
    Object.fromEntries(
      [...Object.keys(expected), "crafting.crafts", "crafting.items"].map(
        (key) => [
          key,
          BigInt(data.metrics.find((m) => m.key === key)?.value ?? "0"),
        ],
      ),
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
  async function clear() {
    await execute("clear ArchiveQA");
    await sync();
  }
  async function give(type, count = 1, position = 0) {
    await execute(
      `replaceitem entity ArchiveQA slot.hotbar ${position} ${type} ${count}`,
    );
    await sync();
    assert.equal(inventory.get(position).count, count);
  }
  async function close(window) {
    bot.queue("container_close", {
      window_id: window,
      window_type: "trading",
      server: false,
    });
    await delay(300);
  }
  async function check(name, trades = 0, items = 0) {
    expected["villager.trades"] += trades;
    expected["villager.items"] += items;
    await delay(800);
    await until(async () => {
      const actual = values(await query());
      assert.equal(actual["crafting.crafts"], baseline["crafting.crafts"]);
      assert.equal(actual["crafting.items"], baseline["crafting.items"]);
      return Object.keys(expected).every(
        (key) => actual[key] - baseline[key] === BigInt(expected[key]),
      );
    });
    cases.push({ name, trades, items });
    console.log(stringify({ stage: name, ...expected }));
  }
  async function state(actor, recipe) {
    const offset = diagnostics().length;
    chat("[QA] inspect trades " + actor.unique_id);
    return until(() => {
      const trace = diagnostics().slice(offset),
        match = trace.match(
          new RegExp(
            `QA trade offer: id=${actor.unique_id} recipe=${recipe.netId} uses=(\\d+) max=(\\d+) sell=([^ ]+) count=(\\d+)`,
          ),
        );
      return match
        ? {
            uses: Number(match[1]),
            max: Number(match[2]),
            type: match[3],
            count: Number(match[4]),
          }
        : null;
    });
  }
  const slot = (container, slot, stack_id = 0) => ({
    slot_type: { container_id: container },
    slot,
    stack_id,
  });
  const input = (position = 0) =>
    slot(
      "hotbar_and_inventory",
      position,
      inventory.get(position)?.stack_id ?? 0,
    );
  const consume = (count, source = input()) => ({
    type_id: "consume",
    legacy_type_id: 5,
    count,
    source,
  });
  const take = (count, id, position = 1) => ({
    type_id: "take",
    legacy_type_id: 0,
    count,
    source: slot("creative_output", 50, id),
    destination: slot(
      "hotbar_and_inventory",
      position,
      inventory.get(position)?.stack_id ?? 0,
    ),
  });
  const craft = (recipe, times = 1) => ({
    type_id: "craft_recipe",
    legacy_type_id: 12,
    recipe_network_id: recipe.netId,
    times_crafted: times,
  });
  async function send(build, success = true) {
    const id = (requestId -= 2),
      offset = diagnostics().length,
      request = {
        request_id: id,
        actions: build(id),
        custom_names: [],
        cause: "chat_public",
      };
    bot.queue("item_stack_request", { requests: [request] });
    const result = await until(() =>
      responses.find((r) => r.request_id === id),
    );
    await sync();
    const trace = diagnostics()
      .slice(offset)
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.includes("QA trade") ||
          l.includes("QA craft") ||
          l.includes("QA stack"),
      );
    console.log(
      stringify({
        stage: "native-trade-request",
        id,
        status: result.status,
        trace,
      }),
    );
    if (success) assert.equal(result.status, "ok", JSON.stringify(result));
    else assert.notEqual(result.status, "ok");
    return { result, trace, id };
  }
  async function open(actor) {
    const before = offers.length;
    bot.queue("player_hotbar", {
      selected_slot: 0,
      window_id: "inventory",
      select_slot: true,
    });
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use_on_entity",
        actions: [],
        transaction_data: {
          entity_runtime_id: actor.runtime_id,
          action_type: "interact",
          hotbar_slot: 0,
          held_item: inventory.get(0),
          player_pos: { ...driver.position },
          click_pos: { x: 0, y: 1, z: 0 },
        },
      },
    });
    const packet = await until(() =>
      offers.slice(before).find((p) => {
        const raw = BigInt(p.villager_unique_id),
          decoded = (raw >> 1n) ^ -(raw & 1n);
        return (
          String(raw) === String(actor.unique_id) ||
          String(decoded) === String(actor.unique_id)
        );
      }),
    );
    writeFileSync(".tools/native-trading-offer-trace.json", stringify(offers));
    console.log(
      stringify({
        stage: "actual-vendor-opened",
        actor: String(actor.unique_id),
        name: packet.display_name,
        newUi: packet.new_trading_ui,
        recipes: packet.offerData.Recipes.filter((r) => r.tier === 0).map(
          (r) => ({
            id: r.netId,
            a: r.buyA.Name,
            b: r.buyB?.Name,
            bCount: r.buyCountB,
            sell: r.sell.Name,
          }),
        ),
      }),
    );
    return packet;
  }
  async function spawn(type = "villager", dimension, profession = "farmer") {
    const before = actors.length;
    const label = "ArchiveTradeQA" + before;
    if (type === "villager" && profession === "fisherman")
      await execute("setblock -1 100 2 barrel");
    await execute(
      `${dimension ? "execute in " + dimension + " run " : ""}summon ${type} 1 100 2${type === "villager" ? " 0 0 minecraft:become_" + profession + " " + label : ""}`,
    );
    const actor = await until(() =>
      actors
        .slice(before)
        .find((p) =>
          type === "villager"
            ? p.entity_type.includes("villager")
            : p.entity_type === "minecraft:" + type,
        ),
    );
    if (type === "villager" && profession === "fisherman")
      await execute(
        `event entity @e[name=${label}] minecraft:become_fisherman`,
      );
    actor.archiveQaName = label;
    return actor;
  }
  function recipeFor(packet, type = "minecraft:bread") {
    const recipe = packet.offerData.Recipes.find(
      (r) =>
        r.tier === 0 &&
        r.buyA.Name === "minecraft:emerald" &&
        r.sell.Name === type &&
        !r.buyCountB,
    );
    assert.ok(recipe, `Actual vanilla offer ${type}`);
    return recipe;
  }
  async function actualTrade(actor, recipe, times = 1, name = "actual-trade") {
    const before = await state(actor, recipe),
      cost = recipe.buyCountA * times,
      produced = recipe.sell.Count * times;
    await clear();
    await give(recipe.buyA.Name, cost + 1);
    if (recipe.buyCountB)
      await give(recipe.buyB.Name, recipe.buyCountB * times + 1, 2);
    const { trace } = await send((id) => [
      craft(recipe, times),
      consume(cost),
      ...(recipe.buyCountB
        ? [consume(recipe.buyCountB * times, input(2))]
        : []),
      take(produced, id),
    ]);
    assert.equal(inventory.get(0).count, 1);
    if (recipe.buyCountB) assert.equal(inventory.get(2).count, 1);
    assert.equal(inventory.get(1).count, produced);
    const registry = bot.archiveQaItemRegistry?.find(
      (i) => i.name === recipe.sell.Name,
    );
    assert.ok(registry);
    assert.equal(inventory.get(1).network_id, registry.runtime_id);
    const after = await state(actor, recipe);
    assert.equal(after.uses - before.uses, times);
    assert.equal(after.type, recipe.sell.Name);
    assert.equal(after.count, recipe.sell.Count);
    assert.ok(
      trace.some((l) =>
        l.includes(`QA trade post before: success=true crafts=${times} `),
      ),
    );
    successes.push({
      name,
      actor: String(actor.unique_id),
      type: actor.entity_type,
      recipe: recipe.netId,
      trades: times,
      items: produced,
      oldScreen: trace.some((l) => l.includes("trade2=false")),
      usesBefore: before.uses,
      usesAfter: after.uses,
      twoIngredients: !!recipe.buyCountB,
    });
    await check(name, times, produced);
  }
  await execute("gamemode creative ArchiveQA");
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  driver.setGrounded(true);
  await execute("gamerule domobspawning false");
  await execute("time set noon");
  await execute("fill -3 99 -3 5 99 6 bedrock");
  await execute("fill -3 100 -3 5 106 6 air");
  await execute("kill @e[family=villager]");
  await execute("kill @e[type=wandering_trader]");
  await execute("setblock 2 100 2 composter");
  await clear();
  await execute("gamemode survival ArchiveQA");
  chat("[QA] enable crafting diagnostics");
  await until(() => diagnostics().includes("QA crafting diagnostics enabled"));
  const farmer = await spawn();
  await give("emerald", 10);
  await check("console-given-currency-is-not-trading");
  let window = await open(farmer);
  assert.equal(window.new_trading_ui, true);
  const bread = recipeFor(window);
  await check("opening-trade-window-is-not-trading");
  let stock = await state(farmer, bread);
  assert.equal(stock.uses, 0);
  await send(() => [craft(bread)], false);
  assert.equal((await state(farmer, bread)).uses, 0);
  await check("recipe-preview-without-payment-is-not-trading");
  await send(
    (id) => [
      { ...craft(bread), recipe_network_id: 99999999 },
      consume(1),
      take(6, id),
    ],
    false,
  );
  await check("unknown-trade-recipe-is-not-counted");
  await actualTrade(farmer, bread, 1, "actual-single-villager-trade");
  await actualTrade(farmer, bread, 3, "three-trades-produce-eighteen-bread");
  await clear();
  await give("emerald", 10);
  stock = await state(farmer, bread);
  let result = await send(
    (id) => [craft(bread), consume(bread.buyCountA), take(63, id)],
    false,
  );
  assert.ok(
    result.trace.some(
      (l) => l.includes("QA trade init:") && l.includes("status=0"),
    ),
  );
  assert.equal(inventory.get(0).count, 10);
  assert.equal(inventory.get(1).count, 0);
  assert.equal((await state(farmer, bread)).uses, stock.uses);
  await check("failure-after-output-initialization-rolls-back");
  const failureStockBefore = stock;
  let offset = diagnostics().length;
  chat("[QA] fail next crafting commit");
  await until(() =>
    diagnostics().slice(offset).includes("QA crafting commit failure armed"),
  );
  result = await send(
    (id) => [
      craft(bread),
      consume(bread.buyCountA),
      take(bread.sell.Count, id),
    ],
    false,
  );
  assert.ok(
    result.trace.some((l) =>
      l.includes("QA crafting commit rejected before origin"),
    ),
  );
  assert.equal(inventory.get(0).count, 10);
  assert.equal(inventory.get(1).count, 0);
  const failureStock = await state(farmer, bread);
  console.log(
    stringify({
      stage: "native-stock-after-rejected-commit",
      before: stock,
      after: failureStock,
    }),
  );
  await check("final-inventory-commit-failure-is-not-counted");
  await clear();
  await give("dirt", 10);
  await send(
    (id) => [
      craft(bread),
      consume(bread.buyCountA),
      take(bread.sell.Count, id),
    ],
    false,
  );
  assert.equal(inventory.get(0).count, 10);
  await check("wrong-payment-item-is-not-trading");
  await clear();
  await send(
    (id) => [
      craft(bread),
      consume(bread.buyCountA),
      take(bread.sell.Count, id),
    ],
    false,
  );
  await check("missing-payment-is-not-trading");
  await execute("give ArchiveQA stone 2304");
  await sync();
  assert.equal(
    [...inventory].filter(([, item]) => item.count === 64).length,
    36,
  );
  await give("emerald", 2);
  await send(
    (id) => [
      craft(bread),
      consume(bread.buyCountA),
      take(bread.sell.Count, id),
    ],
    false,
  );
  assert.equal(inventory.get(0).count, 2);
  assert.equal(inventory.get(1).count, 64);
  await check("full-inventory-trade-rolls-back");
  stock = await state(farmer, bread);
  while (stock.uses < stock.max) {
    const count = Math.min(10, stock.max - stock.uses);
    await actualTrade(
      farmer,
      bread,
      count,
      "actual-trades-consume-remaining-stock-" + stock.uses,
    );
    stock = await state(farmer, bread);
  }
  await clear();
  await give("emerald", 2);
  await send(
    (id) => [
      craft(bread),
      consume(bread.buyCountA),
      take(bread.sell.Count, id),
    ],
    false,
  );
  assert.equal(inventory.get(0).count, 2);
  await check("exhausted-offer-is-not-trading");
  const crops = window.offerData.Recipes.find(
    (r) =>
      r.tier === 0 &&
      r.sell.Name === "minecraft:emerald" &&
      r.buyCountA <= 31 &&
      !r.buyCountB,
  );
  assert.ok(crops);
  await actualTrade(
    farmer,
    crops,
    2,
    "actual-two-crop-sales-return-two-emeralds",
  );
  await close(window.window_id);
  await clear();
  await give("bread", 6);
  await check("console-given-trade-products-are-not-trading");
  if (process.argv.includes("--probe-modern-trades"))
    return { probeOnly: true, cases, successes, increments: expected };
  // Select the genuine old server handler through the separate QA entry guard;
  // prices, stock, inventory operations and statistics remain native.
  chat("[QA] use old trade screen on");
  await until(() => diagnostics().includes("QA old trade screen=true"));
  const legacyFarmer = await spawn();
  await clear();
  window = await open(legacyFarmer);
  const legacyBread = recipeFor(window);
  await check("old-server-trade-handler-open-is-not-a-trade");
  await actualTrade(
    legacyFarmer,
    legacyBread,
    1,
    "actual-old-server-handler-single-trade",
  );
  assert.equal(successes.at(-1).oldScreen, true);
  await actualTrade(
    legacyFarmer,
    legacyBread,
    2,
    "actual-old-server-handler-batch-trade",
  );
  assert.equal(successes.at(-1).oldScreen, true);
  await clear();
  await give("dirt", 10);
  await send(
    (id) => [
      craft(legacyBread),
      consume(legacyBread.buyCountA),
      take(legacyBread.sell.Count, id),
    ],
    false,
  );
  assert.equal(inventory.get(0).count, 10);
  await check("old-handler-wrong-payment-is-not-trading");
  await close(window.window_id);
  offset = diagnostics().length;
  chat("[QA] use old trade screen off");
  await until(() =>
    diagnostics().slice(offset).includes("QA old trade screen=false"),
  );
  const wandering = await spawn("wandering_trader");
  await clear();
  window = await open(wandering);
  const wanderingRecipe =
    window.offerData.Recipes.find(
      (r) =>
        r.tier === 0 &&
        r.buyA.Name === "minecraft:emerald" &&
        !r.buyCountB &&
        r.buyCountA <= 16 &&
        r.sell.Count >= 2,
    ) ??
    window.offerData.Recipes.find(
      (r) =>
        r.tier === 0 &&
        r.buyA.Name === "minecraft:emerald" &&
        !r.buyCountB &&
        r.buyCountA <= 16,
    );
  assert.ok(wanderingRecipe);
  await check("opening-wandering-trader-is-not-trading");
  await actualTrade(
    wandering,
    wanderingRecipe,
    1,
    "actual-wandering-trader-single-trade",
  );
  await actualTrade(
    wandering,
    wanderingRecipe,
    2,
    "actual-wandering-trader-batch-trade",
  );
  await close(window.window_id);
  let fisher, fishRecipe;
  // Vanilla selects different novice offers. Choose an actual two-input
  // variant without replacing offers, stock or recipe IDs.
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = await spawn("villager", undefined, "fisherman");
    await clear();
    window = await open(candidate);
    const selected = window.offerData.Recipes.find(
      (r) =>
        r.tier === 0 &&
        r.buyCountB > 0 &&
        r.buyA.Name === "minecraft:emerald" &&
        r.sell.Count <= 16,
    );
    if (selected) {
      fisher = candidate;
      fishRecipe = selected;
      break;
    }
    await close(window.window_id);
    await execute(`kill @e[name=${candidate.archiveQaName}]`);
  }
  assert.ok(fishRecipe, "Actual vanilla two-ingredient fishing trade");
  await check("opening-two-ingredient-trader-is-not-trading");
  await give(fishRecipe.buyA.Name, fishRecipe.buyCountA + 1);
  await send(
    (id) => [
      craft(fishRecipe),
      consume(fishRecipe.buyCountA),
      take(fishRecipe.sell.Count, id),
    ],
    false,
  );
  assert.equal(inventory.get(0).count, fishRecipe.buyCountA + 1);
  await check("missing-second-trade-ingredient-does-not-count");
  await give("dirt", fishRecipe.buyCountB + 1, 2);
  await send(
    (id) => [
      craft(fishRecipe),
      consume(fishRecipe.buyCountA),
      consume(fishRecipe.buyCountB, input(2)),
      take(fishRecipe.sell.Count, id),
    ],
    false,
  );
  assert.equal(inventory.get(0).count, fishRecipe.buyCountA + 1);
  await check("wrong-second-trade-ingredient-does-not-count");
  assert.equal(inventory.get(2).count, fishRecipe.buyCountB + 1);
  assert.equal(inventory.get(1).count, 0);
  await actualTrade(
    fisher,
    fishRecipe,
    1,
    "actual-two-ingredient-single-trade",
  );
  await actualTrade(fisher, fishRecipe, 2, "actual-two-ingredient-batch-trade");
  await close(window.window_id);
  offset = diagnostics().length;
  chat("[QA] use old trade screen on");
  await until(() =>
    diagnostics().slice(offset).includes("QA old trade screen=true"),
  );
  await clear();
  window = await open(fisher);
  const oldFishRecipe = window.offerData.Recipes.find(
    (r) => r.netId === fishRecipe.netId,
  );
  assert.ok(oldFishRecipe);
  await actualTrade(
    fisher,
    oldFishRecipe,
    2,
    "actual-old-handler-two-ingredient-batch-trade",
  );
  assert.equal(successes.at(-1).oldScreen, true);
  await close(window.window_id);
  offset = diagnostics().length;
  chat("[QA] use old trade screen off");
  await until(() =>
    diagnostics().slice(offset).includes("QA old trade screen=false"),
  );
  await execute("gamemode creative ArchiveQA");
  await clear();
  window = await open(fisher);
  const creativeFishRecipe = window.offerData.Recipes.find(
    (r) => r.netId === fishRecipe.netId,
  );
  assert.ok(creativeFishRecipe);
  await actualTrade(
    fisher,
    creativeFishRecipe,
    1,
    "actual-creative-player-vanilla-trade",
  );
  await close(window.window_id);
  await execute("gamemode survival ArchiveQA");
  const netherBefore = values(await query("minecraft:nether")),
    overworldBefore = values(await query("minecraft:overworld"));
  await execute("execute in nether run tp ArchiveQA 0.5 100 0.5");
  await until(() => driver.changes.at(-1)?.dimension === 1);
  await execute("execute in nether run fill -3 99 -3 5 99 6 bedrock");
  await execute("execute in nether run fill -3 100 -3 5 106 6 air");
  const netherFarmer = await spawn("villager", "nether");
  await clear();
  window = await open(netherFarmer);
  const netherBread = recipeFor(window);
  await actualTrade(
    netherFarmer,
    netherBread,
    1,
    "actual-nether-villager-trade-has-nether-dimension",
  );
  const netherAfter = values(await query("minecraft:nether"));
  assert.equal(
    netherAfter["villager.trades"] - netherBefore["villager.trades"],
    1n,
  );
  assert.equal(
    netherAfter["villager.items"] - netherBefore["villager.items"],
    6n,
  );
  assert.deepEqual(values(await query("minecraft:overworld")), overworldBefore);
  await close(window.window_id);
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  await until(() => driver.changes.at(-1)?.dimension === 0);
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
            .reduce((s, e) => s + Number(e.value), 0),
        ]),
      ),
    ]),
  );
  for (const key of Object.keys(expected)) {
    assert.equal(
      native
        .filter((e) => e.metric === key)
        .reduce((s, e) => s + Number(e.value), 0),
      expected[key],
    );
    assert.ok(
      final.metrics
        .find((m) => m.key === key)
        .measurements.some(
          (m) =>
            m.quality === "EXACT" &&
            m.algorithmVersion === "native-trade-commit-v1",
        ),
    );
  }
  assert.equal(
    successes.reduce((s, r) => s + r.trades, 0),
    expected["villager.trades"],
  );
  assert.equal(
    successes.reduce((s, r) => s + r.items, 0),
    expected["villager.items"],
  );
  const replay = await replayBatch(
    original.find((b) => JSON.parse(b).events.some((e) => ids.has(e.eventId))),
  );
  assert.equal(replay.duplicateBatch, true);
  assert.equal(replay.acceptedEvents, 0);
  assert.deepEqual(values(await query()), values(final));
  return {
    cases,
    successes,
    increments: expected,
    totals: Object.fromEntries(
      Object.entries(values(final))
        .filter(([key]) => Object.hasOwn(expected, key))
        .map(([key, value]) => [key, String(value)]),
    ),
    originalNativeSubjects: subjects,
    originalNativeSumsMatchMcp: true,
    nativeBatchReplayDeduplicated: true,
    finalCommitRollbackVerified: true,
    actualInventoryOutputsVerified: true,
    nativeStockUsesVerified: true,
    oldServerHandlerVerified: true,
    wanderingTraderVerified: true,
    netherDimensionVerified: true,
    craftingCountersUnaffected: true,
    twoIngredientTradesVerified: true,
    twoIngredientOldHandlerVerified: true,
    committedRequests: successes.length,
    nativeEventCount: native.length,
    rejectedCommitStock: {
      before: failureStockBefore.uses,
      after: failureStock.uses,
    },
    quality: "EXACT",
    algorithmVersion: "native-trade-commit-v1",
  };
}
