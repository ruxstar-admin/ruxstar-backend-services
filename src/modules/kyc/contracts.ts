import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const PAN_PATTERN = "^[A-Z]{5}[0-9]{4}[A-Z]$";
export const GSTIN_PATTERN = "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$";
/** Rejections allowed before a case needs support. */
export const MAX_REJECTIONS = 3;

const StoredStatus = [
  Type.Literal("in_progress"),
  Type.Literal("submitted"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
  Type.Literal("locked"),
] as const;
export const CaseStatus = Type.Union([Type.Literal("not_started"), ...StoredStatus], {
  description: "`locked` follows the third rejection; support reopens it.",
});
const StepStatus = Type.Union([Type.Literal("not_started"), Type.Literal("pending"), Type.Literal("verified"), Type.Literal("failed")]);

const Step = { status: StepStatus, reason: Nullable(Type.String({ description: "Why it failed, in words for the user" })) };

const Decision = {
  status: CaseStatus,
  rejectionReason: Nullable(Type.String()),
  rejectionsLeft: Type.Integer({ description: "Rejections before the case locks" }),
  submittedAt: Nullable(DateTime),
  decidedAt: Nullable(DateTime),
};

export const BaseCase = Strict({
  ...Decision,
  steps: Strict({
    aadhaar: Strict({ ...Step, name: Nullable(Type.String()), last4: Nullable(Type.String()) }),
    pan: Strict({ ...Step, masked: Nullable(Type.String({ description: "For example AB******4F" })) }),
    face: Strict(Step),
  }),
});
export type BaseCase = Static<typeof BaseCase>;

/** Indian driving licence numbers: the state, the RTO, the year and a serial, 15 or 16 characters once spaces and dashes go. */
export const LICENCE_PATTERN = "^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,12}$";
/** Number plates: TS09AB1234, or the BH series 22BH1234AB. */
export const PLATE_PATTERN = "^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$";
export const VehicleType = Type.Union([Type.Literal("bike"), Type.Literal("scooter")], { description: "Bikes and scooters only" });
export const DeliveryPhotoKind = Type.Union([Type.Literal("licence"), Type.Literal("vehicle")], {
  description: "`licence` is the front of the driving licence; `vehicle` shows the bike or scooter with its number plate",
});

export const DeliveryCase = Strict({
  ...Decision,
  identityVerified: Type.Boolean({ description: "Identity verification comes first; this track opens once it is approved" }),
  licence: Strict({ number: Nullable(Type.String()), photo: Type.Boolean({ description: "A photo was added" }) }),
  vehicle: Strict({ type: Nullable(VehicleType), number: Nullable(Type.String()), photo: Type.Boolean() }),
});
export type DeliveryCase = Static<typeof DeliveryCase>;

export const DeliveryBody = Strict(
  {
    licenceNumber: Type.Optional(Type.String({ minLength: 10, maxLength: 24, description: "Spaces and dashes are fine" })),
    vehicleType: Type.Optional(VehicleType),
    vehicleNumber: Type.Optional(Type.String({ minLength: 6, maxLength: 16, description: "The number plate; spaces and dashes are fine" })),
  },
  { minProperties: 1 },
);
export const DeliveryPhotoParams = Strict({ kind: DeliveryPhotoKind });

export const Overview = Strict({ base: BaseCase, delivery: DeliveryCase });
export type Overview = Static<typeof Overview>;
export const OverviewResult = Envelope(Overview);

export const DigilockerResult = Envelope(
  Strict({ url: Type.String({ description: "Open this in a browser. DigiLocker sends the user back to the Ruxstar return page." }) }),
);

export const PanBody = Strict({ pan: Type.String({ pattern: PAN_PATTERN, description: "10 characters, capitals, like ABCDE1234F" }) });

export const Card = Strict({
  id: Type.String({ description: "For example RUX-1A2B-3C4D" }),
  name: Type.String({ description: "As on the Aadhaar" }),
  photoUrl: Nullable(Type.String()),
  aadhaar: Type.String({ description: "Masked, for example XXXX XXXX 1234" }),
  pan: Nullable(Type.String({ description: "Masked" })),
  vendor: Type.Boolean({ description: "Verified people are vendors and can open the vendor portal" }),
  memberSince: DateTime,
  profileUrl: Type.String({ description: "The public profile, for the QR code" }),
});
export type Card = Static<typeof Card>;
export const CardResult = Envelope(Card);

// Review queue, under /v1/ruxstar.

export const ReviewTrack = Type.Union([Type.Literal("base"), Type.Literal("delivery")], {
  description: "`base` is identity; `delivery` is a delivery partner's licence and vehicle",
});
export const ReviewQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([...StoredStatus], { default: "submitted" })),
  track: Type.Optional(Type.Union([Type.Literal("base"), Type.Literal("delivery")], { default: "base" })),
});

export const ReviewCase = Strict({
  id: ObjectIdString,
  track: ReviewTrack,
  status: CaseStatus,
  rejections: Type.Integer(),
  user: Strict({
    id: ObjectIdString,
    name: Type.String(),
    username: Type.String(),
    phone: Type.String(),
    avatarUrl: Nullable(Type.String()),
    memberSince: DateTime,
  }),
  identity: Strict({
    aadhaarName: Nullable(Type.String()),
    aadhaarLast4: Nullable(Type.String()),
    panMasked: Nullable(Type.String()),
    panName: Nullable(Type.String({ description: "The name the tax department has for this PAN" })),
    nameMatch: Nullable(Type.String({ description: "Cashfree's grade, for example DIRECT_MATCH" })),
    livenessScore: Nullable(Type.Number()),
    faceMatchScore: Nullable(Type.Number()),
  }),
  delivery: Nullable(
    Strict(
      {
        licenceNumber: Nullable(Type.String()),
        licencePhotoUrl: Nullable(Type.String({ description: "Opens without signing in; works for 10 minutes" })),
        vehicleType: Nullable(VehicleType),
        vehicleNumber: Nullable(Type.String()),
        vehiclePhotoUrl: Nullable(Type.String()),
      },
      { description: "Delivery cases only. Check the licence photo matches the number and the plate in the vehicle photo matches its number" },
    ),
  ),
  submittedAt: Nullable(DateTime),
  review: Nullable(Strict({ decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]), reason: Nullable(Type.String()), at: DateTime })),
});
export type ReviewCase = Static<typeof ReviewCase>;
export const ReviewList = ListEnvelope(ReviewCase);
export const ReviewOne = Envelope(ReviewCase);
export const CaseParams = Strict({ id: ObjectIdString });
export const RejectBody = Strict({
  reason: Type.String({ minLength: 5, maxLength: 300, description: "Shown to the user, so say what to fix" }),
});
