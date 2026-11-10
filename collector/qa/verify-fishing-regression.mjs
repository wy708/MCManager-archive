import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const proof = JSON.parse(
  readFileSync(
    path.join(root, ".tools/native-fishing-basic-evidence.json"),
    "utf8",
  ),
);
assert.equal(proof.realGameplay, true);
assert.equal(proof.cleanGameStop, true);
assert.equal(proof.nativeCollectorVersion, "0.19.0");
for (const key of [
  "actualClientReceivedReply",
  "nativeDeliveryReceipt",
  "stableRequestDeduplicated",
  "agentRepliesExcludedFromDefaultInput",
  "offlineTargetFailedHonestly",
])
  assert.equal(proof[key], true);
assert.equal(proof.behaviors.positiveExperiencePoints, "11020");
const cache = path.join(
  root,
  ".tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged",
);
const batches = readdirSync(cache)
  .filter((n) => n.endsWith(".pending"))
  .map((n) =>
    JSON.parse(JSON.parse(readFileSync(path.join(cache, n), "utf8")).body),
  );
const boot = batches.find((b) =>
  b.events.some((e) => e.eventId === proof.messageId),
)?.collector.bootId;
assert.ok(boot);
const own = batches.filter((b) => b.collector.bootId === boot);
const events = own
  .flatMap((b) => b.events)
  .filter((e) => e.metric?.startsWith("fishing."));
assert.equal(events.length, 0);
for (const batch of own) {
  assert.equal(batch.collector.version, proof.nativeCollectorVersion);
  for (const key of [
    "fishing.retrievals",
    "fishing.item_pull_events",
    "fishing.items_pulled",
    "fishing.catch_events",
    "fishing.catches",
  ])
    assert.ok(
      batch.capabilities.some(
        (c) =>
          c.metric === key &&
          c.state === "ACTIVE" &&
          c.quality === "EXACT" &&
          c.algorithmVersion === "native-fishing-result-v1",
      ),
    );
}
const evidence = {
  verifiedAt: new Date().toISOString(),
  actualGameEvidenceAt: proof.verifiedAt,
  boot,
  nativeCollectorVersion: proof.nativeCollectorVersion,
  fishingActive: true,
  fishingEvents: 0,
  actualBasicBehaviorAndReplyRegression: true,
};
writeFileSync(
  path.join(root, ".tools/native-fishing-regression-exclusions.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
