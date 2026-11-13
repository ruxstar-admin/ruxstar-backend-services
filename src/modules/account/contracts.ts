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
const Purpose = Type.Union([Type.Literal("signup"), Type.Literal("reset"), Type.Literal("login")]);
const Gender = Type.Union([Type.Literal("female"), Type.Literal("male"), Type.Literal("other")]);
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Email = Type.String({ format: "email", maxLength: 254 });
const Dob = Type.String({ format: "date", description: "YYYY-MM-DD. At least 13 years ago." });
const Device = {
  deviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Apps only. Stable per install." })),
  deviceName: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Apps only, for example \"Pixel 8\"" })),
};

const Stats = Strict({
  posts: Type.Integer({ description: "Live posts, both tabs" }),
  engagements: Type.Integer({ description: "Likes and comments the posts have received" }),
  followers: Type.Integer(),
  following: Type.Integer({ description: "How many people they follow" }),
});

export const User = Strict({
  id: ObjectIdString,
  phone: Type.String({ description: "E.164, for example +919876543210" }),
  name: Type.String(),
  username: Type.String(),
  email: Nullable(Type.String()),
  emailVerified: Type.Boolean({ description: "False until the code sent by POST /email/code is entered" }),
  avatarUrl: Nullable(Type.String({ description: "512 x 512 WebP. Null until a photo is added." })),
  bio: Nullable(Type.String()),
  dob: Nullable(Type.String({ format: "date" })),
  gender: Nullable(Gender),
  city: Nullable(Type.String()),
  roles: Strict({
    vendor: Type.Boolean(),
    delivery: Type.Boolean(),
    ruxstarStaff: Type.Boolean(),
    admin: Type.Boolean(),
  }),
  kyc: Strict({
    base: Type.String({ description: "none, pending, approved or rejected. Details at GET /v1/kyc" }),
    vendor: Type.String({ description: "none, pending, approved or rejected" }),
  }),
  card: Nullable(Strict({ id: Type.String({ description: "For example RUX-1A2B-3C4D. The full card is at GET /v1/kyc/card" }) })),
  stats: Stats,
  showActivity: Type.Boolean({
    description: "Activity status: people they chat with see when they were last active. Off, they don't see anyone else's either.",
  }),
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
  username: Type.Optional(Username),
  dob: Type.Optional(Dob),
  gender: Type.Optional(Gender),
  email: Type.Optional(Email),
  ...Device,
});
export const SignupResult = SignedIn;

export const LoginBody = Strict({ phone: Phone, password: Type.String({ minLength: 1, maxLength: 64 }), ...Device });
export const LoginResult = SignedIn;

export const LoginCodeBody = Strict({
  phone: Phone,
  code: Type.String({ pattern: "^\\d{6}$", description: "The code texted by POST /otp with purpose login" }),
  ...Device,
});

export const RefreshBody = Strict({
  refreshToken: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Apps only. The website sends a cookie." })),
});
export const RefreshResult = Envelope(Strict({ tokens: Type.Optional(Tokens) }));

export const Done = Envelope(Strict({ done: Type.Literal(true) }));

export const ResetBody = Strict({ verificationToken: Type.String({ minLength: 1, maxLength: 2000 }), password: Password });
export const ChangePasswordBody = Strict({ currentPassword: Type.String({ minLength: 1, maxLength: 64 }), newPassword: Password });

export const MeResult = Envelope(User);
export const DeleteBody = Strict({ password: Type.String({ minLength: 1, maxLength: 64, description: "The current password" }) });

export const EmailCodeSent = Envelope(
  Strict({
    sentTo: Type.String({ description: "Masked, for example as***@gmail.com" }),
    expiresInSeconds: Type.Integer(),
    resendInSeconds: Type.Integer(),
  }),
);
export const EmailVerifyBody = Strict({ code: Type.String({ pattern: "^\\d{6}$" }) });
export const MePatch = Strict(
  {
    name: Type.Optional(Name),
    username: Type.Optional(Username),
    email: Type.Optional(Nullable(Email)),
    bio: Type.Optional(Nullable(Type.String({ maxLength: 160 }))),
    dob: Type.Optional(Nullable(Type.String({ format: "date" }))),
    gender: Type.Optional(Nullable(Gender)),
    city: Type.Optional(Nullable(Type.String({ minLength: 2, maxLength: 60 }))),
    showActivity: Type.Optional(Type.Boolean({ description: "Off forgets when they were last active and hides everyone else's from them" })),
  },
  { minProperties: 1 },
);

export const UsernameQuery = Strict({
  check: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "A handle to check, as typed" })),
  name: Type.Optional(
    Type.String({ minLength: 1, maxLength: 60, description: "Before signup, suggestions come from this name. Signed in, your own name is used." }),
  ),
});
export const UsernameResult = Envelope(
  Strict({
    available: Nullable(Type.Boolean({ description: "Null when nothing was checked" })),
    suggestions: Type.Array(Type.String(), { description: "Free handles from the user's name, best first" }),
  }),
);

export const CityQuery = Strict({
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lng: Type.Number({ minimum: -180, maximum: 180 }),
});
export const CityResult = Envelope(
  Strict({
    city: Nullable(Type.String()),
    attribution: Type.String({ description: "Show this wherever the city is shown as looked up" }),
  }),
);

/** What anyone can see. Never phone, email, date of birth or gender. */
export const PublicProfile = Strict({
  id: ObjectIdString,
  name: Type.String(),
  username: Type.String(),
  avatarUrl: Nullable(Type.String()),
  bio: Nullable(Type.String()),
  city: Nullable(Type.String()),
  badges: Strict({
    verified: Type.Boolean({ description: "Identity verified by Ruxstar" }),
    vendor: Type.Boolean(),
    delivery: Type.Boolean(),
  }),
  stats: Stats,
  memberSince: DateTime,
});
export type PublicProfile = Static<typeof PublicProfile>;
export const ProfileResult = Envelope(PublicProfile);
export const ProfileParams = Strict({
  ref: Type.String({ minLength: 3, maxLength: 24, description: "A username, or a user id" }),
});
export const ProfileSearchQuery = Strict({
  q: Type.Optional(Type.String({ minLength: 2, maxLength: 40, description: "The start of a username, or of any word in a name. Leave out for the newest members." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 20 })),
});
export const ProfileList = ListEnvelope(PublicProfile);

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
