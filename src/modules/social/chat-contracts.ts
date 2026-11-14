import { Type, type Static } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";
import { Author } from "./contracts.js";

export const MESSAGE_TEXT_MAX = 1000;
export const GROUP_TITLE_MAX = 60;
/** Everyone in a group, the creator included, and anyone still deciding on an invite. */
export const GROUP_MAX = 50;

/** The longest voice message, and the most loudness bars its waveform keeps. */
export const VOICE_MAX_MS = 2 * 60_000;
export const VOICE_LEVELS_MAX = 48;
export const REACTION_MAX_LENGTH = 16;

const MessageKind = Type.Union([Type.Literal("text"), Type.Literal("post"), Type.Literal("photo"), Type.Literal("voice"), Type.Literal("event")]);
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
  activeAt: Type.Union([DateTime, Type.Null()], { description: "1:1 chats: when the other person last had Ruxstar open, to the minute. Show \"Active now\" or \"Active 5m ago\"." }),
});
export const ChatDetailResult = Envelope(ChatDetail);

export const SharedPost = Strict({
  id: ObjectIdString,
  available: Type.Boolean({ description: "False when the post was deleted, or you can't see its author" }),
  author: Type.Union([Author, Type.Null()]),
  text: Type.String({ description: "The start of the post" }),
  photo: Type.Union([Type.String(), Type.Null()], { description: "A small copy of its first photo" }),
});

export const ReplyPreview = Strict({
  id: ObjectIdString,
  available: Type.Boolean({ description: "False once that message was unsent" }),
  sender: Type.String({ description: "Their name; \"You\" for your own" }),
  mine: Type.Boolean(),
  kind: MessageKind,
  text: Type.String({ description: "The start of it, or \"Photo\", \"Voice message\" or \"Post\"" }),
});

export const ReactionCount = Strict({
  emoji: Type.String(),
  count: Type.Integer({ minimum: 1 }),
  mine: Type.Boolean({ description: "This one is yours" }),
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
  voice: Type.Union([
    Strict({
      url: Type.String({ description: "AAC in MP4. Works for at least an hour and answers Range requests." }),
      durationMs: Type.Integer(),
      levels: Type.Array(Type.Integer({ minimum: 0, maximum: 100 }), { description: "Loudness bars for its waveform; may be empty" }),
    }),
    Type.Null(),
  ]),
  replyTo: Type.Union([ReplyPreview, Type.Null()]),
  reactions: Type.Array(ReactionCount, { description: "Each emoji once, in the order first used. One reaction per person." }),
  createdAt: DateTime,
});
export type Message = Static<typeof Message>;
export const MessageResult = Envelope(Message);
export const MessageList = ListEnvelope(Message);

export const ChatUpdates = Envelope(
  Strict({
    messages: Type.Array(Message, {
      description: "Sent since `since`, oldest first, up to 100. Includes a few seconds before it, so merge by id. When 100 come back, `now` is set so the next call picks up the rest.",
    }),
    updated: Type.Array(Message, { description: "Older messages whose reactions changed since `since`. Replace the ones you have." }),
    unsent: Type.Array(ObjectIdString, { description: "Messages unsent since `since`. Remove them." }),
    seenAt: Type.Union([DateTime, Type.Null()]),
    activeAt: Type.Union([DateTime, Type.Null()], { description: "1:1 chats: when the other person last had Ruxstar open" }),
    typing: Type.Array(Author, { description: "Others typing right now. Hide each after about 6 seconds unless the next answer still has them." }),
    changed: Type.Boolean({ description: "The chat's name, people or admins changed. Fetch it again." }),
    now: Type.String({ format: "date-time", description: "Send it as the next call's `since`." }),
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
export const UpdatesQuery = Strict({
  since: DateTime,
  wait: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 25,
      default: 0,
      description: "Seconds to hold the call open when nothing has changed yet. It answers the moment something does.",
    }),
  ),
});
const ReplyTo = { replyToId: Type.Optional(ObjectIdString) };
export const MediaQuery = Strict({ ...ReplyTo });
export const VoiceQuery = Strict({
  ...ReplyTo,
  durationMs: Type.Integer({ minimum: 300, maximum: VOICE_MAX_MS + 1000 }),
  levels: Type.Optional(Type.String({ pattern: "^\\d{1,3}(,\\d{1,3}){0,47}$", description: "Up to 48 loudness bars, 0-100, comma separated" })),
});
export const ReactBody = Strict({ emoji: Type.String({ minLength: 1, maxLength: REACTION_MAX_LENGTH }) });
export const TypingBody = Strict({ typing: Type.Boolean() });

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
  ...ReplyTo,
});
export const MuteBody = Strict({ muted: Type.Boolean() });
