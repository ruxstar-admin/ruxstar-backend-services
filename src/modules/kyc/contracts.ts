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

export const Overview = Strict({ base: BaseCase });
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

export const ReviewQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([...StoredStatus], { default: "submitted" })),
});

export const ReviewCase = Strict({
  id: ObjectIdString,
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
