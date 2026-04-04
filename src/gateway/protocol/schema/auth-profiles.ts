import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const AuthProfilesUpsertParamsSchema = Type.Object(
  {
    profileId: NonEmptyString,
    credential: Type.Object(
      {
        type: Type.Literal("api_key"),
        provider: NonEmptyString,
        key: NonEmptyString,
        email: Type.Optional(NonEmptyString),
        metadata: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type AuthProfilesUpsertParams = Static<typeof AuthProfilesUpsertParamsSchema>;
