import { Type, type Static, type TSchema } from "typebox";
import { Client, DateTime, Envelope, ListEnvelope, ObjectIdString, Strict } from "../../contracts/common.js";

export const Phone = Type.String({
  pattern: "^[6-9]\\d{9}$",
  description: "10-digit Indian mobile number, without +91",
  examples: ["9876543210"],
});
const Password = Type.String({ minLength: 8, maxLength: 64, description: "8 to 64 characters with a letter and a number" });
const Name = Type.String({ minLength: 2, maxLength: 60, pattern: "\\S" });
const Username = Type.String({ pattern: "^[a-z0-9_.]{3,20}$", description: "3 to 20 lowercase letters, digits, _ or ." });
const Purpose = Type.Union([Type.Literal("signup"), Type.Literal("reset")]);
const Gender = Type.Union([Type.Literal("female"), Type.Literal("male"), Type.Literal("other")]);
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Device = {
  deviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Apps only. Stable per install." })),
  deviceName: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Apps only, for example \"Pixel 8\"" })),
};

export const User = Strict({
  id: ObjectIdString,
  phone: Type.String({ description: "E.164, for example +919876543210" }),
  name: Type.String(),
  username: Type.String(),
  dob: Nullable(Type.String({ format: "date" })),
  gender: Nullable(Gender),
  city: Nullable(Type.String()),
  roles: Strict({
    vendor: Type.Boolean(),
    delivery: Type.Boolean(),
    ruxstarStaff: Type.Boolean(),
    admin: Type.Boolean(),
  }),
  kyc: Strict({ base: Type.String() }),
  createdAt: DateTime,
});
export type User = Static<typeof User>;

export const Tokens = Strict({
  accessToken: Type.String(),
  accessTokenExpiresIn: Type.Integer({ description: "Seconds" }),
  refreshToken: Type.String({ description: "Single use. Each refresh returns a new one." }),
  refreshTokenExpiresAt: DateTime,
});

/** The website receives cookies, so `tokens` is only present for the apps. */
const SignedIn = Envelope(Strict({ user: User, tokens: Type.Optional(Tokens) }));

export const OtpRequest = Strict({ phone: Phone, purpose: Purpose });
export const OtpSent = Envelope(
  Strict({
    sentTo: Type.String({ description: "Masked, for example +91 ••••• •3210" }),
    expiresInSeconds: Type.Integer(),
    resendInSeconds: Type.Integer(),
  }),
);

export const OtpVerify = Strict({ phone: Phone, purpose: Purpose, code: Type.String({ pattern: "^\\d{6}$" }) });
export const Verified = Envelope(
  Strict({
    verificationToken: Type.String({ description: "Pass to signup or password reset. Works once." }),
    expiresInSeconds: Type.Integer(),
  }),
);

export const SignupBody = Strict({
  verificationToken: Type.String({ minLength: 1, maxLength: 2000 }),
  name: Name,
  password: Password,
  acceptTerms: Type.Literal(true, { description: "The user accepted the current terms and privacy policy" }),
  ...Device,
});
export const SignupResult = SignedIn;

export const LoginBody = Strict({ phone: Phone, password: Type.String({ minLength: 1, maxLength: 64 }), ...Device });
export const LoginResult = SignedIn;

export const RefreshBody = Strict({
  refreshToken: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Apps only. The website sends a cookie." })),
});
export const RefreshResult = Envelope(Strict({ tokens: Type.Optional(Tokens) }));

export const Done = Envelope(Strict({ done: Type.Literal(true) }));

export const ResetBody = Strict({ verificationToken: Type.String({ minLength: 1, maxLength: 2000 }), password: Password });
export const ChangePasswordBody = Strict({ currentPassword: Type.String({ minLength: 1, maxLength: 64 }), newPassword: Password });

export const MeResult = Envelope(User);
export const MePatch = Strict(
  {
    name: Type.Optional(Name),
    username: Type.Optional(Username),
    dob: Type.Optional(Nullable(Type.String({ format: "date" }))),
    gender: Type.Optional(Nullable(Gender)),
    city: Type.Optional(Nullable(Type.String({ minLength: 2, maxLength: 60 }))),
  },
  { minProperties: 1 },
);

export const Session = Strict({
  id: ObjectIdString,
  client: Client,
  label: Type.String(),
  current: Type.Boolean(),
  lastSeenAt: DateTime,
  createdAt: DateTime,
});
export const SessionList = ListEnvelope(Session);
export const SessionParams = Strict({ id: ObjectIdString });

export const DeviceBody = Strict({ pushToken: Type.String({ minLength: 1, maxLength: 500 }) });
