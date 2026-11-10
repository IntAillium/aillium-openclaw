import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAuthProfileWithLock } from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./store.js";

describe("auth profile runtime snapshots", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-snapshot-"));
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("serves a profile upserted after the snapshot was taken", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);

    await upsertAuthProfileWithLock({
      agentDir,
      profileId: "google:aillium",
      credential: { type: "api_key", provider: "google", key: "test-key" },
    });

    const store = ensureAuthProfileStore(agentDir);
    expect(store.profiles["google:aillium"]).toMatchObject({
      provider: "google",
      key: "test-key",
    });
  });
});
