import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inputDriver } from "./input-driver.mjs";
export async function verifyFishing({
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
    items = [],
    cases = [],
    catches = [];
  let snapshots = 0;
  const driver = inputDriver(bot);
  const keys = [
    "fishing.retrievals",
    "fishing.item_pull_events",
    "fishing.items_pulled",
    "fishing.catch_events",
    "fishing.catches",
  ];
  const expected = Object.fromEntries(keys.map((k) => [k, 0]));
  bot.on("add_entity", (p) => actors.push(p));
  bot.on("add_item_entity", (p) => items.push(p));
  bot.on("inventory_slot", (p) => {
    if (["inventory", 0].includes(p.window_id)) inventory.set(p.slot, p.item);
  });
  bot.on("inventory_content", (p) => {
    if (["inventory", 0].includes(p.window_id)) {
      p.input.forEach((item, slot) => inventory.set(slot, item));
      snapshots++;
    }
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
      keys.map((k) => [
        k,
        BigInt(data.metrics.find((m) => m.key === k)?.value ?? 0),
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
  function use() {
    driver.input(undefined, undefined, {
      legacy: { legacy_request_id: 0 },
      actions: [],
      data: {
        action_type: "click_air",
        trigger_type: "player_input",
        block_position: { x: 0, y: 100, z: 1 },
        face: 1,
        hotbar_slot: 0,
        hand: "main_hand",
        held_item: inventory.get(0),
        player_pos: { ...driver.position },
        click_pos: { x: 0.5, y: 1, z: 0.5 },
        block_runtime_id: 0,
        client_prediction: "success",
        client_cooldown_state: "off",
      },
    });
  }
  async function state() {
    const offset = diagnostics().length;
    chat("[QA] inspect fishing");
    return until(() => {
      const trace = diagnostics().slice(offset);
      if (trace.includes("QA fishing state: none")) return { none: true };
      const m = trace.match(
        /QA fishing state: id=(-?\d+) removed=(true|false) hooked=(-?\d+) lured=(-?\d+) nibble=(-?\d+) ground=(true|false) water=([\d.e+-]+) pos=([^\r\n]+)/,
      );
      return m
        ? {
            id: m[1],
            removed: m[2] === "true",
            hooked: Number(m[3]),
            lured: Number(m[4]),
            nibble: Number(m[5]),
            ground: m[6] === "true",
            water: Number(m[7]),
            position: m[8],
          }
        : null;
    });
  }
  async function control(value) {
    const offset = diagnostics().length;
    chat("[QA] fishing control " + value);
    await until(() =>
      diagnostics()
        .slice(offset)
        .includes("QA fishing control armed: " + value),
    );
  }
  async function check(
    name,
    retrieval = 0,
    pullEvents = 0,
    pullItems = 0,
    catchEvents = 0,
    catchItems = 0,
  ) {
    const change = [retrieval, pullEvents, pullItems, catchEvents, catchItems];
    keys.forEach((k, i) => (expected[k] += change[i]));
    await until(async () => {
      const v = values(await query());
      for (const k of keys) {
        assert.ok(
          v[k] <= baseline[k] + BigInt(expected[k]),
          `${name}: ${k} overcount`,
        );
        if (v[k] !== baseline[k] + BigInt(expected[k])) return false;
      }
      return true;
    });
    await delay(300);
    const v = values(await query());
    for (const k of keys)
      assert.equal(v[k], baseline[k] + BigInt(expected[k]), `${name}: ${k}`);
    const entry = {
      name,
      increments: Object.fromEntries(keys.map((k, i) => [k, change[i]])),
    };
    cases.push(entry);
    console.log(stringify({ stage: "fishing-case", ...entry }));
  }
  async function cast() {
    await sync();
    assert.equal((await state()).none, true);
    const offset = diagnostics().length;
    use();
    await until(() =>
      diagnostics().slice(offset).includes("QA fishing rod use:"),
    );
    const s = await state();
    assert.equal(s.none, undefined);
    return s;
  }
  async function retrieve(alreadySynced = false) {
    if (!alreadySynced) await sync();
    const offset = diagnostics().length;
    use();
    await until(() =>
      diagnostics().slice(offset).includes("QA fishing rod use:"),
    );
    await delay(150);
    return { state: await state(), trace: diagnostics().slice(offset) };
  }
  async function bite() {
    let value;
    await until(async () => {
      value = await state();
      assert.equal(value.none, undefined, "Fishing hook disappeared");
      if (value.nibble >= 6) return true;
      await delay(25);
      return false;
    }, 100_000);
    return value;
  }
  async function natural(
    name,
    { control: setting, quantity, creative = false } = {},
  ) {
    await cast();
    if (setting) await control(setting);
    await sync();
    const ready = await bite();
    const before = items.length;
    const result = await retrieve(true);
    assert.equal(result.state.none, true);
    const newItems = items.slice(before);
    if (setting === "cancel-spawn") {
      assert.match(result.trace, /QA fishing spawn cancelled/);
      assert.equal(newItems.length, 0);
      await check(name, 1);
      return;
    }
    const match = result.trace.match(
      /QA fishing spawn: item=(\S+) count=(\d+) spawner=minecraft:fishing_hook result=(-?\d+)/,
    );
    assert.ok(match, `${name}: native loot spawn missing`);
    const count = quantity ?? Number(match[2]);
    assert.ok(
      newItems.some((p) => p.item.count === count),
      "Actual spawned item quantity",
    );
    assert.match(
      result.trace,
      setting === "cancel-pull"
        ? /QA fishing pull cancelled/
        : new RegExp("itemCount=" + count + " fromFishing=true"),
    );
    await check(
      name,
      1,
      setting === "cancel-pull" ? 0 : 1,
      setting === "cancel-pull" ? 0 : count,
      1,
      count,
    );
    catches.push({
      name,
      type: match[1],
      count,
      bite: ready,
      creative,
      pullCancelled: setting === "cancel-pull",
      actualEntityAdded: true,
    });
    return { id: match[3], type: match[1], count };
  }
  await execute("gamemode creative ArchiveQA");
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  driver.setGrounded(true);
  driver.setView(20, 0);
  await execute("gamerule domobspawning false");
  await execute("weather clear");
  await execute("time set noon");
  await execute("kill @e[family=villager]");
  await execute("kill @e[type=wandering_trader]");
  await execute("kill @e[type=trader_llama]");
  await execute("kill @e[type=item]");
  await execute("kill @e[type=fishing_hook]");
  await execute("fill -16 96 2 16 96 26 stone");
  await execute("fill -16 97 2 16 99 26 water");
  await execute("fill -16 100 2 16 112 26 air");
  await execute("fill -3 99 -3 3 99 1 stone");
  await execute("fill -3 100 -3 3 108 1 air");
  await execute("clear ArchiveQA");
  await execute("gamemode survival ArchiveQA");
  await execute("replaceitem entity ArchiveQA slot.hotbar 0 fishing_rod 1");
  await sync();
  bot.queue("player_hotbar", {
    selected_slot: 0,
    window_id: "inventory",
    select_slot: true,
  });
  await delay(200);
  chat("[QA] enable fishing diagnostics");
  await until(() => diagnostics().includes("QA fishing diagnostics enabled"));
  await control("cancel-use");
  await sync();
  use();
  await until(() => diagnostics().includes("QA fishing use cancelled"));
  assert.equal((await state()).none, true);
  await check("cancelled actual rod use");
  await cast();
  await check("casting alone");
  await control("cancel-retrieve");
  let r = await retrieve();
  assert.match(r.trace, /QA fishing retrieve cancelled/);
  assert.equal(r.state.none, true);
  await check("cancelled native retrieval is not a completed retrieval");
  await execute("kill @e[type=fishing_hook]");
  await cast();
  r = await retrieve();
  assert.equal(r.state.none, true);
  await check("empty retrieval after cancellation", 1);
  await cast();
  r = await retrieve();
  assert.equal(r.state.none, true);
  await check("immediate empty retrieval", 1);
  for (const [kind, count, type] of [
    ["normal", 5, "dirt"],
    ["old", 7, "cod"],
  ]) {
    await cast();
    const offset = diagnostics().length;
    chat("[QA] fishing item " + kind);
    await until(() =>
      diagnostics()
        .slice(offset)
        .includes("QA fishing existing item attached:"),
    );
    r = await retrieve();
    assert.match(
      r.trace,
      new RegExp("itemCount=" + count + " fromFishing=" + (kind === "old")),
    );
    assert.equal(r.state.none, true);
    await check(
      "existing " + type + " is pulled but not new catch",
      1,
      1,
      count,
    );
  }
  await cast();
  chat("[QA] fishing item normal");
  await until(() =>
    diagnostics().includes("QA fishing existing item attached:"),
  );
  await delay(200);
  await control("cancel-pull");
  r = await retrieve();
  assert.match(r.trace, /QA fishing pull cancelled/);
  assert.equal(r.state.none, true);
  await check("cancelled pull of existing item", 1);
  const beforeMob = actors.length;
  await execute("summon cow 0.5 100 4");
  const mob = await until(() =>
    actors.slice(beforeMob).find((p) => p.entity_type === "minecraft:cow"),
  );
  await cast();
  const raw = BigInt(mob.unique_id);
  let attached = false;
  for (const id of new Set([raw, (raw >> 1n) ^ -(raw & 1n)])) {
    const offset = diagnostics().length;
    chat("[QA] fishing target " + id);
    await delay(200);
    if (diagnostics().slice(offset).includes("type=minecraft:cow")) {
      attached = true;
      break;
    }
  }
  assert.equal(attached, true);
  r = await retrieve();
  assert.match(r.trace, /type=minecraft:cow itemCount=0/);
  assert.equal(r.state.none, true);
  await check("pulling a real cow is not an item or catch", 1);
  await execute("kill @e[type=cow]");
  await execute("fill -5 100 2 5 106 2 stone");
  await cast();
  await until(async () => (await state()).ground, 15_000);
  r = await retrieve();
  assert.equal(r.state.none, true);
  assert.doesNotMatch(r.trace, /QA fishing spawn:/);
  await check("native hook stuck in stone", 1);
  await execute("fill -5 100 2 5 106 2 air");
  await natural("natural survival catch");
  await natural("native quantity seven fixture", {
    control: "quantity7",
    quantity: 7,
  });
  await natural("new catch with pull cancelled", { control: "cancel-pull" });
  await natural("native item spawn rejected", { control: "cancel-spawn" });
  await cast();
  await bite();
  await until(async () => (await state()).nibble === 0, 10_000);
  const missed = await state();
  assert.equal(missed.nibble, 0);
  r = await retrieve();
  assert.equal(r.state.none, true);
  assert.doesNotMatch(r.trace, /QA fishing spawn:/);
  await check("missed bite empty retrieval", 1);
  for (let slot = 1; slot < 36; slot++) {
    await execute(
      `replaceitem entity ArchiveQA slot.${slot < 9 ? "hotbar" : "inventory"} ${slot < 9 ? slot : slot - 9} dirt 64`,
    );
  }
  await sync();
  assert.equal([...inventory.values()].filter((i) => i.count > 0).length, 36);
  const retainedCatch = await natural("natural catch with full inventory");
  await sync();
  assert.equal([...inventory.values()].filter((i) => i.count > 0).length, 36);
  await cast();
  const rehookOffset = diagnostics().length;
  chat("[QA] fishing target " + retainedCatch.id);
  await until(() =>
    diagnostics()
      .slice(rehookOffset)
      .includes("QA fishing existing actor attached:"),
  );
  r = await retrieve();
  assert.match(
    r.trace,
    new RegExp(
      "target=" +
        retainedCatch.id +
        " type=minecraft:item itemCount=" +
        retainedCatch.count +
        " fromFishing=true",
    ),
  );
  assert.equal(r.state.none, true);
  assert.doesNotMatch(r.trace, /QA fishing spawn:/);
  await check(
    "rehook the same naturally created catch",
    1,
    1,
    retainedCatch.count,
  );
  await execute("clear ArchiveQA");
  await execute("replaceitem entity ArchiveQA slot.hotbar 0 fishing_rod 1");
  await sync();
  await execute("gamemode creative ArchiveQA");
  await cast();
  r = await retrieve();
  assert.equal(r.state.none, true);
  await check("creative empty retrieval", 1);
  await natural("natural creative catch", { creative: true });
  await execute("gamemode survival ArchiveQA");
  await cast();
  await execute("kill @e[type=fishing_hook]");
  await until(async () => (await state()).none);
  await check("hook removed without retrieval");
  const netherBefore = values(await query("minecraft:nether"));
  await execute("execute in nether run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  await execute("execute in nether run fill -3 99 -3 3 99 3 stone");
  await execute("execute in nether run fill -3 100 -3 3 108 3 air");
  await cast();
  r = await retrieve();
  assert.equal(r.state.none, true);
  await check("nether empty retrieval", 1);
  const nether = values(await query("minecraft:nether"));
  assert.equal(nether[keys[0]] - netherBefore[keys[0]], 1n);
  for (const k of keys.slice(1)) assert.equal(nether[k] - netherBefore[k], 0n);
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  const final = await query();
  const activity = [];
  let cursor = begin;
  for (let page = 0; page < 100; page++) {
    const result = await tool("get_recent_activity", {
      serverId,
      after: cursor,
      limit: 100,
    });
    activity.push(...result.items);
    if (!result.hasMore) break;
    assert.notEqual(result.nextCursor, cursor);
    cursor = result.nextCursor;
    assert.ok(page < 99);
  }
  const events = activity.filter((e) => keys.includes(e.metric)),
    ids = new Set(events.map((e) => e.eventId));
  assert.equal(ids.size, events.length);
  const originals = readdirSync(cache)
      .filter((n) => n.endsWith(".pending"))
      .map((n) => JSON.parse(readFileSync(path.join(cache, n), "utf8")).body),
    native = originals
      .flatMap((b) => JSON.parse(b).events)
      .filter((e) => ids.has(e.eventId));
  assert.equal(native.length, events.length);
  const subjects = Object.fromEntries(
    keys.map((k) => [
      k,
      Object.fromEntries(
        [
          ...new Set(
            native.filter((e) => e.metric === k).map((e) => e.subject),
          ),
        ].map((s) => [
          s,
          native
            .filter((e) => e.metric === k && e.subject === s)
            .reduce((v, e) => v + Number(e.value), 0),
        ]),
      ),
    ]),
  );
  for (const k of keys) {
    assert.equal(
      native
        .filter((e) => e.metric === k)
        .reduce((v, e) => v + Number(e.value), 0),
      expected[k],
    );
    assert.ok(
      final.metrics
        .find((m) => m.key === k)
        .measurements.some(
          (m) =>
            m.quality === "EXACT" &&
            m.algorithmVersion === "native-fishing-result-v1",
        ),
    );
  }
  const replay = await replayBatch(
    originals.find((b) => JSON.parse(b).events.some((e) => ids.has(e.eventId))),
  );
  assert.equal(replay.duplicateBatch, true);
  assert.equal(replay.acceptedEvents, 0);
  assert.deepEqual(values(await query()), values(final));
  return {
    cases,
    catches,
    increments: expected,
    totals: Object.fromEntries(
      Object.entries(values(final)).map(([k, v]) => [k, String(v)]),
    ),
    originalNativeSubjects: subjects,
    nativeEventCount: native.length,
    originalNativeSumsMatchMcp: true,
    nativeBatchReplayDeduplicated: true,
    naturalBiteVerified: true,
    oldFishingItemExcluded: true,
    naturallyCreatedItemRehooked: true,
    quantityFixtureVerified: true,
    cancellationsVerified: true,
    netherDimensionVerified: true,
    quality: "EXACT",
    algorithmVersion: "native-fishing-result-v1",
  };
}
