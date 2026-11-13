import { Type, type Static } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";
import { Author } from "./contracts.js";

export const MESSAGE_TEXT_MAX = 1000;
export const GROUP_TITLE_MAX = 60;
/** Everyone in a group, the creator included, and anyone still deciding on an invite. */
export const GROUP_MAX = 50;

const MessageKind = Type.Union([Type.Literal("text"), Type.Literal("post"), Type.Literal("photo"), Type.Literal("event")]);
const MemberState = Type.Union([Type.Literal("active"), Type.Literal("request")], {
  description: "`request`: someone you don't follow started it or added you. Accept to reply; it sits in Requests until then.",
});

export const ChatPreview = Strict({
  kind: MessageKind,
  text: Type.String({ description: "Ready to show, for example \"Sent a photo\" or \"Shared a post\"" }),
  mine: Type.Boolean(),
  at: DateTime,
});

export const Chat = Strict({
  id: ObjectIdString,
  kind: Type.Union([Type.Literal("dm"), Type.Literal("group")]),
  title: Type.String({ description: "The group's name, or the other person's name in a 1:1 chat" }),
  peer: Type.Union([Author, Type.Null()], { description: "1:1 chats only: the other person" }),
  members: Type.Integer({ description: "People in it, invites included" }),
  state: MemberState,
  muted: Type.Boolean(),
  unread: Type.Integer({ minimum: 0 }),
  admin: Type.Boolean({ description: "Groups: you can add and remove people, rename it and make admins" }),
  canSend: Type.Boolean(),
  waiting: Type.Boolean({ description: "1:1 chats: your request hasn't been accepted, and you've sent your one message" }),
  last: Type.Union([ChatPreview, Type.Null()]),
  createdAt: DateTime,
});
export type Chat = Static<typeof Chat>;
export const ChatResult = Envelope(Chat);
export const ChatList = ListEnvelope(Chat);

export const ChatPerson = Strict({
  ...Author.properties,
  admin: Type.Boolean(),
  state: MemberState,
  me: Type.Boolean(),
});

export const ChatDetail = Strict({
  ...Chat.properties,
  people: Type.Array(ChatPerson, { description: "Everyone in it, you first. Groups list up to 50; 1:1 chats list both people." }),
  seenAt: Type.Union([DateTime, Type.Null()], { description: "1:1 chats: when the other person last read it. Show Seen under your messages up to then." }),
});
export const ChatDetailResult = Envelope(ChatDetail);

export const SharedPost = Strict({
  id: ObjectIdString,
  available: Type.Boolean({ description: "False when the post was deleted, or you can't see its author" }),
  author: Type.Union([Author, Type.Null()]),
  text: Type.String({ description: "The start of the post" }),
  photo: Type.Union([Type.String(), Type.Null()], { description: "A small copy of its first photo" }),
});

export const Message = Strict({
  id: ObjectIdString,
  chatId: ObjectIdString,
  kind: MessageKind,
  sender: Type.Union([Author, Type.Null()], { description: "Null for group lines like \"Asha added Ravi\"" }),
  mine: Type.Boolean(),
  text: Type.String(),
  post: Type.Union([SharedPost, Type.Null()]),
  photo: Type.Union([Strict({ url: Type.String({ description: "Works for at least an hour" }), width: Type.Integer(), height: Type.Integer() }), Type.Null()]),
  createdAt: DateTime,
});
export type Message = Static<typeof Message>;
export const MessageResult = Envelope(Message);
export const MessageList = ListEnvelope(Message);

export const ChatUpdates = Envelope(
  Strict({
    messages: Type.Array(Message, { description: "Sent since `since`, oldest first. Includes a few seconds before it, so merge by id." }),
    unsent: Type.Array(ObjectIdString, { description: "Messages unsent since `since`. Remove them." }),
    seenAt: Type.Union([DateTime, Type.Null()]),
    changed: Type.Boolean({ description: "The chat's name, people or admins changed. Fetch it again." }),
    now: DateTime,
  }),
);

export const ChatUnread = Envelope(
  Strict({
    unread: Type.Integer({ description: "Unread messages in chats that aren't muted" }),
    requests: Type.Integer({ description: "Message requests waiting" }),
  }),
);

export const ChatParams = Strict({ id: ObjectIdString });
export const MessageParams = Strict({ id: ObjectIdString, messageId: ObjectIdString });
export const MemberParams = Strict({ id: ObjectIdString, userId: ObjectIdString });

export const ChatListQuery = Strict({
  box: Type.Optional(Type.Union([Type.Literal("chats"), Type.Literal("requests")], { default: "chats" })),
  ...PageQuery,
});
export const MessagePageQuery = Strict({ ...PageQuery });
export const UpdatesQuery = Strict({ since: DateTime });

export const StartDm = Strict({ userId: ObjectIdString });
export const CreateGroup = Strict({
  title: Type.String({ minLength: 1, maxLength: GROUP_TITLE_MAX }),
  userIds: Type.Array(ObjectIdString, { minItems: 1, maxItems: GROUP_MAX - 1, uniqueItems: true }),
});
export const RenameGroup = Strict({ title: Type.String({ minLength: 1, maxLength: GROUP_TITLE_MAX }) });
export const AddPeople = Strict({ userIds: Type.Array(ObjectIdString, { minItems: 1, maxItems: GROUP_MAX - 1, uniqueItems: true }) });
export const SendMessage = Strict({
  text: Type.Optional(Type.String({ maxLength: MESSAGE_TEXT_MAX })),
  postId: Type.Optional(ObjectIdString),
});
export const MuteBody = Strict({ muted: Type.Boolean() });
