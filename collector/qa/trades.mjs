import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { inputDriver } from "./input-driver.mjs";
const require = createRequire(import.meta.url),
  nbt = require("prismarine-nbt");
async function verifyTradeProbe({
  bot,
  command,
  until,
  diagnostics,
  tool,
  serverId,
  playerKey,
}) {
  const actors = [],
    offers = [],
    inventory = new Map(),
    responses = [];
  let snapshots = 0;
  const driver = inputDriver(bot);
  bot.on("item_stack_response", (packet) =>
    responses.push(...packet.responses),
  );
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
  const stringify = (value) =>
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v));
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
    await delay(250);
  }
  async function sync() {
    const before = snapshots;
    chat("[QA] sync inventory");
    await until(() => snapshots > before);
  }
  const query = () => tool("get_player_statistics", { serverId, playerKey }),
    values = (data) =>
      Object.fromEntries(
        ["villager.trades", "villager.items"].map((key) => [
          key,
          BigInt(data.metrics.find((m) => m.key === key)?.value ?? "0"),
        ]),
      ),
    baseline = values(await query());
  await execute("gamemode creative ArchiveQA");
  await execute("execute in overworld run tp ArchiveQA 0.5 100 0.5");
  bot.queue("serverbound_loading_screen", { type: 2 });
  driver.setGrounded(true);
  await execute("fill -3 99 -3 5 99 6 bedrock");
  await execute("fill -3 100 -3 5 106 6 air");
  await execute("kill @e[type=villager]");
  await execute("clear ArchiveQA");
  await sync();
  await execute(
    "summon villager 1 100 2 0 0 minecraft:become_" +
      (process.argv.includes("--probe-fisher") ? "fisherman" : "farmer"),
  );
  const villager = await until(() =>
    actors.find((p) => p.entity_type.includes("villager")),
  );
  console.log(
    stringify({
      stage: "actual-villager-spawned",
      id: villager.unique_id,
      position: villager.position,
    }),
  );
  await execute("setblock 2 100 2 composter");
  await execute("gamemode survival ArchiveQA");
  bot.queue("player_hotbar", {
    selected_slot: 0,
    window_id: "inventory",
    select_slot: true,
  });
  chat("[QA] enable crafting diagnostics");
  await until(() => diagnostics().includes("QA crafting diagnostics enabled"));
  if (process.argv.includes("--probe-old-trades")) {
    chat("[QA] use old trade screen on");
    await until(() => diagnostics().includes("QA old trade screen=true"));
  }
  const offset = diagnostics().length;
  bot.queue("inventory_transaction", {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: "item_use_on_entity",
      actions: [],
      transaction_data: {
        entity_runtime_id: villager.runtime_id,
        action_type: "interact",
        hotbar_slot: 0,
        held_item: inventory.get(0),
        player_pos: { ...driver.position },
        click_pos: { x: 0, y: 1, z: 0 },
      },
    },
  });
  await until(() => offers.length > 0);
  writeFileSync(".tools/native-trading-offers.json", stringify(offers));
  console.log(
    stringify({
      stage: "actual-trade-offers",
      offers: offers.map(({ offers, ...p }) => p),
      trace: diagnostics().slice(offset),
    }),
  );
  if (process.argv.includes("--probe-fisher"))
    return { probeOnly: true, actualTradeWindowOpened: true };
  const recipe = offers
    .at(-1)
    .offerData.Recipes.find(
      (r) =>
        r.tier === 0 &&
        r.buyA.Name === "minecraft:emerald" &&
        r.sell.Name === "minecraft:bread",
    );
  assert.ok(recipe);
  await execute("replaceitem entity ArchiveQA slot.hotbar 0 emerald 10");
  await sync();
  const slot = (container, slot, stack_id = 0) => ({
      slot_type: { container_id: container },
      slot,
      stack_id,
    }),
    id = -301,
    request = {
      request_id: id,
      actions: [
        {
          type_id: "craft_recipe",
          legacy_type_id: 12,
          recipe_network_id: recipe.netId,
          times_crafted: 1,
        },
        {
          type_id: "consume",
          legacy_type_id: 5,
          count: recipe.buyCountA,
          source: slot("hotbar_and_inventory", 0, inventory.get(0).stack_id),
        },
        {
          type_id: "take",
          legacy_type_id: 0,
          count: recipe.sell.Count,
          source: slot("creative_output", 50, id),
          destination: slot("hotbar_and_inventory", 1),
        },
      ],
      custom_names: [],
      cause: "chat_public",
    };
  const start = diagnostics().length;
  bot.queue("item_stack_request", { requests: [request] });
  const result = await until(() => responses.find((r) => r.request_id === id));
  await sync();
  console.log(
    stringify({
      stage: "actual-trade-request",
      request,
      result,
      inventory: [...inventory].filter(([, item]) => item.count > 0),
      trace: diagnostics().slice(start),
    }),
  );
  await until(async () => {
    const actual = values(await query());
    return (
      actual["villager.trades"] - baseline["villager.trades"] === 1n &&
      actual["villager.items"] - baseline["villager.items"] === 6n
    );
  });
  chat("[QA] inspect trades " + villager.unique_id);
  await delay(300);
  console.log(
    stringify({
      stage: "actual-trade-native-use",
      trace: diagnostics()
        .slice(start)
        .split(/\r?\n/)
        .filter(
          (l) => l.includes("QA trading actor") || l.includes("QA trade offer"),
        ),
    }),
  );
  return {
    probeOnly: true,
    actualTradeWindowOpened: true,
    requestStatus: result.status,
    actualNativeTradeIngested: true,
  };
}

export async function verifyTrades(options) {
  if (
    process.argv.includes("--probe-trades") ||
    process.argv.includes("--probe-old-trades") ||
    process.argv.includes("--probe-fisher")
  )
    return verifyTradeProbe(options);
  return (await import("./trades-acceptance.mjs")).verifyTradeAcceptance(
    options,
  );
}
