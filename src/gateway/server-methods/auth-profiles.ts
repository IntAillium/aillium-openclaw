import { upsertAuthProfileWithLock } from "../../agents/auth-profiles/profiles.js";
import { validateAuthProfilesUpsertParams } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const authProfilesHandlers: GatewayRequestHandlers = {
  "auth_profiles.upsert": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateAuthProfilesUpsertParams, "auth_profiles.upsert", respond)
    ) {
      return;
    }

    const typed = params;
    await upsertAuthProfileWithLock({
      profileId: typed.profileId,
      credential: {
        type: "api_key",
        provider: typed.credential.provider,
        key: typed.credential.key,
        ...(typed.credential.email ? { email: typed.credential.email } : {}),
        ...(typed.credential.metadata ? { metadata: typed.credential.metadata } : {}),
      },
    });

    respond(true, { ok: true, profileId: typed.profileId }, undefined);
  },
};
