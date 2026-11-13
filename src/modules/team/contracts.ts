import { Type, type Static } from "typebox";
import { DateTime, Envelope, ModuleName, ObjectIdString, Strict } from "../../contracts/common.js";

/** A business's team holds at most this many people, invites included. */
export const MAX_TEAM = 20;
export const INVITE_DAYS = 7;

export const TeamPermission = Type.Union(
  [
    Type.Literal("orders.view"),
    Type.Literal("orders.move"),
    Type.Literal("orders.reject"),
    Type.Literal("orders.refund"),
    Type.Literal("earnings.view"),
    Type.Literal("shop.open"),
    Type.Literal("shop.catalog"),
    Type.Literal("shop.details"),
    Type.Literal("coupons.manage"),
    Type.Literal("posts.create"),
  ],
  { description: "What the owner lets this person do at the business" },
);

const PermissionInfo = Strict({
  key: TeamPermission,
  label: Type.String(),
  hint: Type.Union([Type.String(), Type.Null()]),
  needs: Type.Union([TeamPermission, Type.Null()], { description: "Given with this one, since it can't work without it" }),
});

const Person = Strict({
  id: ObjectIdString,
  name: Type.String(),
  username: Type.Union([Type.String(), Type.Null()]),
  avatar: Type.Union([Type.String(), Type.Null()]),
});

export const TeamMember = Strict({
  id: ObjectIdString,
  person: Person,
  status: Type.Union([Type.Literal("invited"), Type.Literal("waiting"), Type.Literal("active")], {
    description: "`invited` hasn't accepted yet; `waiting` accepted but isn't verified, so nothing works for them yet",
  }),
  permissions: Type.Array(TeamPermission),
  invitedAt: DateTime,
  expiresAt: Type.Union([DateTime, Type.Null()], { description: "When the invite runs out; null once accepted" }),
  joinedAt: Type.Union([DateTime, Type.Null()]),
});
export type TeamMember = Static<typeof TeamMember>;

export const Team = Strict({
  members: Type.Array(TeamMember, { description: "Active people first, then invites, oldest first" }),
  permissions: Type.Array(PermissionInfo),
  max: Type.Integer({ description: "People the team can hold, invites included" }),
});
export const TeamOne = Envelope(Team);
export const TeamMemberOne = Envelope(TeamMember);

const Permissions = Type.Array(TeamPermission, { minItems: 1, maxItems: 10, uniqueItems: true });

export const InviteBody = Strict({
  username: Type.String({ minLength: 3, maxLength: 20, description: "Their Ruxstar username, without the @" }),
  permissions: Permissions,
});
export const PermissionsBody = Strict({ permissions: Permissions });
export const TeamParams = Strict({ id: ObjectIdString });
export const MemberParams = Strict({ id: ObjectIdString, memberId: ObjectIdString });
export const RemoveBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "Kept in the audit log; the owner and the person see it" }) });

const WorkBusiness = Strict({
  id: ObjectIdString,
  name: Type.String(),
  module: ModuleName,
  type: Type.String(),
  city: Type.Union([Type.String(), Type.Null()]),
  photo: Type.Union([Type.String(), Type.Null()], { description: "The cover photo's URL" }),
  status: Type.Union([Type.Literal("draft"), Type.Literal("live")]),
  open: Type.Boolean(),
});

const WorkInvite = Strict({
  id: ObjectIdString,
  business: WorkBusiness,
  owner: Strict({ name: Type.String() }),
  permissions: Type.Array(TeamPermission),
  invitedAt: DateTime,
  expiresAt: DateTime,
});

export const WorkPlace = Strict({
  id: ObjectIdString,
  business: WorkBusiness,
  owner: Strict({ name: Type.String() }),
  permissions: Type.Array(TeamPermission),
  joinedAt: DateTime,
  access: Type.Union([Type.Literal("on"), Type.Literal("verify"), Type.Literal("on_hold")], {
    description: "`verify`: get verified before anything works; `on_hold`: Ruxstar put the business on hold",
  }),
});
export type WorkPlace = Static<typeof WorkPlace>;

export const Work = Strict({
  invites: Type.Array(WorkInvite, { description: "Newest first" }),
  places: Type.Array(WorkPlace, { description: "Newest first" }),
  permissions: Type.Array(PermissionInfo),
});
export const WorkOne = Envelope(Work);
export const WorkPlaceOne = Envelope(WorkPlace);
export const WorkParams = Strict({ id: ObjectIdString });
