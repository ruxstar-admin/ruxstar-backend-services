import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, dayOf } from "../src/modules/coaching/rules.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>> & { username: string };
const BACK = "https://ruxstar.com/classes";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const TELANGANA_GSTIN = "36AABCU9603R1ZM";
const VENUE = { name: "Ace Academy", address: "Road 12, Banjara Hills", city: "Hyderabad" };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "10:00", minutes: 60 }));

describe("coaching", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.coachingCourses.deleteMany({}),
      stack.db.coachingBatches.deleteMany({}),
      stack.db.coachingSessions.deleteMany({}),
      stack.db.coachingOrders.deleteMany({}),
      stack.db.coachingChildren.deleteMany({}),
      stack.db.coachingAttendance.deleteMany({}),
      stack.db.coachingMaterials.deleteMany({}),
      stack.db.coachingMessages.deleteMany({}),
      stack.db.coachingCertificates.deleteMany({}),
      stack.db.coupons.deleteMany({}),
      stack.db.couponRedemptions.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.invoices.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne(
      { module: "coaching" },
      { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 }, $unset: { coachingRules: "" } },
    );
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const sweep = () => stack.app.inject({ method: "POST", url: "/jobs/orders", headers: { authorization: `Bearer ${JOB_TOKEN}` } });

  let n = 0;
  async function person(opts: { verified?: boolean; vendor?: boolean; name?: string } = {}): Promise<User> {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `learner${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Kiran Das", username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } },
    );
    return { ...user, username };
  }
  const coach = () => person({ vendor: true, verified: true, name: "Asha Rao" });

  async function business(owner: User, gstin = false) {
    const _id = new ObjectId();
    await stack.db.businesses.insertOne({
      _id,
      ownerId: owner.userId,
      module: "coaching",
      type: "coaching",
      name: "Ace Coaching",
      description: null,
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Banjara Hills", pincode: "500034" },
      pod: null,
      gstin: gstin ? { number: TELANGANA_GSTIN, legalName: "Ace Coaching LLP", status: "Active" } : null,
      photos: [],
      status: "live",
      open: true,
      publishedAt: new Date(),
      ...stamp(),
    } as never);
    return _id.toHexString();
  }

  const courseBody = (extra: object = {}) => ({
    title: "Class 10 Maths",
    description: "Board exam preparation.",
    category: "tuition",
    mode: "offline",
    venue: VENUE,
    demo: null,
    ...extra,
  });
  const batchBody = (extra: object = {}) => ({
    name: "Morning batch",
    fee: 300_000,
    capacity: 10,
    minStudents: null,
    slots: EVERY_DAY,
    startDate: addDays(dayOf(new Date()), 2),
    classes: 4,
    endDate: null,
    onlineLink: null,
    coachIds: [],
    ...extra,
  });

  type Course = { id: string; batches: { id: string; seatsLeft: number; classes: number; status: string }[] };
  async function course(owner: User, businessId: string, extra: { course?: object; batch?: object } = {}): Promise<Course> {
    const created = await call("POST", `/vendor/businesses/${businessId}/courses`, owner.token, courseBody(extra.course));
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    const batched = await call("POST", `/vendor/courses/${id}/batches`, owner.token, batchBody(extra.batch));
    expect(batched.statusCode).toBe(201);
    const published = await call("POST", `/vendor/courses/${id}/publish`, owner.token);
    expect(published.statusCode).toBe(200);
    return published.json().data;
  }

  /** Opens the checkout link the way a browser does and presses the test button. */
  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    const page = await stack.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "confirmed" });
  }

  async function enrol(customer: User, batchId: string, childId: string | null = null, extra: object = {}) {
    return call("POST", `/coaching/batches/${batchId}/enrol`, customer.token, { student: { childId }, returnTo: BACK, ...extra });
  }
  async function enrolPaid(customer: User, batchId: string, childId: string | null = null) {
    const res = await enrol(customer, batchId, childId);
    expect(res.statusCode).toBe(201);
    await pay(res.json().data.checkoutUrl);
    return res.json().data.order as { id: string; orderNo: number };
  }

  /** Moves a batch's classes, and everything dated by them, `ms` earlier. */
  async function shift(batchId: string, ms: number) {
    const _id = new ObjectId(batchId);
    const back = (field: string) => ({ $cond: [{ $eq: [{ $type: `$${field}` }, "date"] }, { $subtract: [`$${field}`, ms] }, `$${field}`] });
    await stack.db.coachingSessions.updateMany({ batchId: _id }, [{ $set: { startsAt: back("startsAt"), endsAt: back("endsAt") } }]);
    await stack.db.coachingBatches.updateOne({ _id }, [{ $set: { firstAt: back("firstAt"), firstEndsAt: back("firstEndsAt"), lastEndsAt: back("lastEndsAt") } }]);
    await stack.db.coachingOrders.updateMany({ batchId: _id }, [{ $set: { firstAt: back("firstAt"), firstEndsAt: back("firstEndsAt"), releaseAt: back("releaseAt") } }]);
  }
  /** Moves a batch so its first class has just ended, or with `started`, is under way. */
  async function pastFirstClass(batchId: string, { started = false } = {}) {
    const batch = (await stack.db.coachingBatches.findOne({ _id: new ObjectId(batchId) }))!;
    const target = started ? batch.firstAt.getTime() + 30 * 60_000 : batch.firstEndsAt.getTime() + 60_000;
    await shift(batchId, target - Date.now());
  }

  async function staff(permissions: string[]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Ops", modules: [], permissions, grantedBy: user.userId, status: "active", ...stamp() });
    return user;
  }

  async function teamMember(owner: User, businessId: string, permissions: string[], verified = true) {
    const who = await person({ verified, name: "Gopal Teacher" });
    const invited = await call("POST", `/vendor/businesses/${businessId}/team`, owner.token, { username: who.username, permissions });
    expect(invited.statusCode).toBe(201);
    const accepted = await call("POST", `/employment/${invited.json().data.id}/accept`, who.token);
    expect(accepted.statusCode).toBe(200);
    return who;
  }

  const notesFor = (userId: ObjectId) => stack.db.notifications.find({ userId }).sort({ createdAt: 1, _id: 1 }).toArray();
  const invoicesOf = (orderId: string) => stack.db.invoices.find({ "source.id": new ObjectId(orderId) }).sort({ issuedAt: 1, _id: 1 }).toArray();

  it("makes a course with a batch, says what publishing needs, and lists it for customers once live", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const created = await call("POST", `/vendor/businesses/${bizId}/courses`, owner.token, courseBody());
    expect(created.json().data).toMatchObject({ status: "draft", certificatePercent: 75, missing: ["Add a batch whose first class is in the future"] });
    const id = created.json().data.id as string;
    expect((await call("POST", `/vendor/courses/${id}/publish`, owner.token)).json().error).toMatchObject({ code: "BUSINESS_INCOMPLETE" });

    const both = await call("POST", `/vendor/courses/${id}/batches`, owner.token, batchBody({ endDate: addDays(dayOf(new Date()), 30) }));
    expect(both.json().error.details[0].path).toBe("body/classes");
    const clash = await call("POST", `/vendor/courses/${id}/batches`, owner.token, batchBody({ slots: [{ day: 1, start: "10:00", minutes: 60 }, { day: 1, start: "10:30", minutes: 60 }] }));
    expect(clash.json().error.details[0].path).toBe("body/slots/1");
    const link = await call("POST", `/vendor/courses/${id}/batches`, owner.token, batchBody({ onlineLink: "https://meet.example.com/x" }));
    expect(link.json().error.details[0].path).toBe("body/onlineLink");
    const tooBig = await call("POST", `/vendor/courses/${id}/batches`, owner.token, batchBody({ capacity: 500 }));
    expect(tooBig.json().error.details[0].path).toBe("body/capacity");

    const batched = await call("POST", `/vendor/courses/${id}/batches`, owner.token, batchBody());
    expect(batched.json().data.batches).toMatchObject([{ name: "Morning batch", classes: 4, seatsLeft: 10, status: "open", schedule: "Every day 10–11 am" }]);
    expect((await call("POST", `/vendor/courses/${id}/publish`, owner.token)).json().data).toMatchObject({ status: "live", missing: [] });

    const customer = await person();
    const list = (await call("GET", "/coaching?city=hyderabad&category=tuition", customer.token)).json().data;
    expect(list).toMatchObject([{ id, title: "Class 10 Maths", feeFrom: 300_000, openBatches: 1, mode: "offline", venueName: "Ace Academy" }]);
    expect((await call("GET", "/coaching?city=pune&online=false", customer.token)).json().data).toEqual([]);
    expect((await call("GET", "/coaching?online=true", customer.token)).json().data).toEqual([]);
    const detail = (await call("GET", `/coaching/${id}`, customer.token)).json().data;
    expect(detail).toMatchObject({ canEnrol: true, platformFee: 500, batches: [{ seatsLeft: 10, enrolled: 0, classes: 4 }], demoClasses: [] });
    expect(detail.refundRule).toContain("before the first class");
  });

  it("enrols and pays like tickets: holds the seat, issues GST documents, and refunds in full before the first class", async () => {
    const owner = await coach();
    const bizId = await business(owner, true);
    const { batches } = await course(owner, bizId);
    const batchId = batches[0]!.id;
    const customer = await person();

    const placed = await enrol(customer, batchId);
    expect(placed.statusCode).toBe(201);
    const { order, checkoutUrl } = placed.json().data;
    expect(order).toMatchObject({ status: "awaiting_payment", kind: "batch", student: { childId: null, name: "Kiran Das" }, price: { items: 300_000, platformFee: 500, total: 300_500 } });
    expect((await stack.db.coachingBatches.findOne({ _id: new ObjectId(batchId) }))!.seatsLeft).toBe(9);
    expect((await enrol(customer, batchId)).json().error).toMatchObject({ code: "CONFLICT", message: "You are already in this batch." });

    await pay(checkoutUrl);
    const view = (await call("GET", `/coaching/orders/${order.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ status: "confirmed", canCancel: true, classes: expect.any(Array), attendance: { held: 0, needed: 75 } });
    expect(view.classes).toHaveLength(4);
    const ledger = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(ledger).toMatchObject([{ kind: "payment", bucket: "pending", signedPaise: 270_000 }]);

    const [sale, fee] = await invoicesOf(order.id);
    expect(sale).toMatchObject({ kind: "tax_invoice", module: "coaching", lines: [{ code: "999293", codeKind: "sac", unitPrice: 300_000, rateBps: 1800 }] });
    expect(fee).toMatchObject({ role: "fee", totals: { total: 500 } });
    expect(view.invoices).toHaveLength(2);
    const vendorNote = (await notesFor(owner.userId)).find((x) => x.title.startsWith("New enrolment"));
    expect(vendorNote?.body).toContain("₹2,700 to you after the first class");

    const cancelled = await call("POST", `/coaching/orders/${order.id}/cancel`, customer.token);
    expect(cancelled.json().data).toMatchObject({ status: "cancelled", refund: { amount: 300_500, status: "done" } });
    const notes = (await invoicesOf(order.id)).filter((d) => d.kind === "credit_note");
    expect(notes.map((x) => x.totals.total)).toEqual([300_000, 500]);
    expect((await stack.db.coachingBatches.findOne({ _id: new ObjectId(batchId) }))!.seatsLeft).toBe(10);
    const after = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(after.reduce((s, e) => s + e.signedPaise, 0)).toBe(0);
    expect((await enrol(customer, batchId)).statusCode).toBe(201);
  });

  it("takes a vendor's coupon on a coaching business", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { batches } = await course(owner, bizId);
    const made = await call("POST", "/vendor/coupons", owner.token, { code: "ACE500", kind: "flat", value: 50_000, businessIds: [bizId] });
    expect(made.statusCode).toBe(201);
    expect((await stack.db.coupons.findOne({ code: "ACE500" }))!.modules).toEqual(["coaching"]);
    const customer = await person();
    const offers = (await call("GET", `/coaching/batches/${batches[0]!.id}/offers?code=ace500`, customer.token)).json().data;
    expect(offers).toMatchObject({ offers: [{ code: "ACE500", discount: 50_000 }], checked: { code: "ACE500", discount: 50_000, problem: null } });
    const res = await enrol(customer, batches[0]!.id, null, { coupon: "ACE500" });
    expect(res.json().data.order).toMatchObject({ price: { items: 300_000, discount: 50_000, total: 250_500 }, coupon: { code: "ACE500", fundedBy: "vendor" } });
    await pay(res.json().data.checkoutUrl);
    expect(await stack.db.couponRedemptions.countDocuments({})).toBe(1);
    const order = (await stack.db.coachingOrders.findOne({}))!;
    expect(order.price.commission).toBe(25_000);
  });

  it("gives one demo class per student per course, free or paid, and none once enrolled", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { id, batches } = await course(owner, bizId, { course: { demo: { fee: 0, seats: 2 } } });
    const parent = await person();
    const detail = (await call("GET", `/coaching/${id}`, parent.token)).json().data;
    expect(detail.demoClasses).toHaveLength(4);
    const sessionId = detail.demoClasses[0].sessionId as string;

    const demo = await call("POST", `/coaching/${id}/demo`, parent.token, { sessionId, student: { childId: null }, returnTo: BACK });
    expect(demo.json().data).toMatchObject({ checkoutUrl: null, order: { kind: "demo", status: "confirmed", price: { total: 0 } } });
    const again = await call("POST", `/coaching/${id}/demo`, parent.token, { sessionId: detail.demoClasses[1].sessionId, student: { childId: null }, returnTo: BACK });
    expect(again.json().error.message).toContain("already had your demo class");

    const child = (await call("POST", "/coaching/children", parent.token, { name: "Meera Das", birthYear: 2014 })).json().data;
    const childDemo = await call("POST", `/coaching/${id}/demo`, parent.token, { sessionId, student: { childId: child.id }, returnTo: BACK });
    expect(childDemo.statusCode).toBe(201);
    const third = await person();
    const full = await call("POST", `/coaching/${id}/demo`, third.token, { sessionId, student: { childId: null }, returnTo: BACK });
    expect(full.json().error.message).toBe("This class has no demo places left. Pick another.");

    await enrolPaid(third, batches[0]!.id);
    const enrolled = await call("POST", `/coaching/${id}/demo`, third.token, { sessionId: detail.demoClasses[1].sessionId, student: { childId: null }, returnTo: BACK });
    expect(enrolled.json().error.message).toBe("You are already enrolled in this course.");
    expect((await call("GET", `/coaching/${id}`, parent.token)).json().data.demoTaken).toHaveLength(2);

    await stack.db.coachingCourses.updateOne({ _id: new ObjectId(id) }, { $set: { "demo.fee": 20_000 } });
    const paid = await person();
    const paidDemo = await call("POST", `/coaching/${id}/demo`, paid.token, { sessionId: detail.demoClasses[1].sessionId, student: { childId: null }, returnTo: BACK });
    expect(paidDemo.json().data.order.price).toMatchObject({ items: 20_000, platformFee: 500, total: 20_500 });
    await pay(paidDemo.json().data.checkoutUrl);
    expect((await stack.db.coachingOrders.findOne({ _id: new ObjectId(paidDemo.json().data.order.id as string) }))!.status).toBe("confirmed");
  });

  it("lets a parent enrol children as students, shows their timetable, and keeps a booked child", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { batches } = await course(owner, bizId);
    const parent = await person({ name: "Lakshmi Das" });
    const meera = (await call("POST", "/coaching/children", parent.token, { name: "Meera Das", birthYear: 2014 })).json().data;
    const arjun = (await call("POST", "/coaching/children", parent.token, { name: "Arjun Das", birthYear: null })).json().data;
    expect((await call("POST", "/coaching/children", parent.token, { name: "meera das", birthYear: null })).statusCode).toBe(409);
    const stranger = await person();
    expect((await enrol(stranger, batches[0]!.id, meera.id)).json().error.details[0].path).toBe("body/student/childId");

    const order = await enrolPaid(parent, batches[0]!.id, meera.id);
    await enrolPaid(parent, batches[0]!.id, arjun.id);
    expect((await enrol(parent, batches[0]!.id, meera.id)).json().error.message).toBe("Meera Das is already in this batch.");
    const mine = (await call("GET", "/coaching/orders", parent.token)).json().data;
    expect(mine.map((o: { student: { name: string } }) => o.student.name).sort()).toEqual(["Arjun Das", "Meera Das"]);
    expect(mine[0].student.childId).not.toBeNull();

    const timetable = (await call("GET", `/coaching/timetable?days=7`, parent.token)).json().data;
    expect(timetable).toHaveLength(8);
    expect(timetable[0]).toMatchObject({ kind: "batch", course: { title: "Class 10 Maths" }, class: { status: "upcoming", joinLink: null } });

    const children = (await call("GET", "/coaching/children", parent.token)).json().data;
    expect(children).toMatchObject([{ name: "Meera Das", enrolments: 1 }, { name: "Arjun Das", enrolments: 1 }]);
    expect((await call("DELETE", `/coaching/children/${meera.id}`, parent.token)).json().error.message).toBe("Meera Das has classes booked. Cancel them first.");
    await call("POST", `/coaching/orders/${order.id}/cancel`, parent.token);
    expect((await call("DELETE", `/coaching/children/${meera.id}`, parent.token)).statusCode).toBe(200);
  });

  it("marks attendance by tick list and issues certificates at the course's percent, with a PDF", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const teacher = await teamMember(owner, bizId, ["classes.view", "classes.attendance"]);
    const { batches } = await course(owner, bizId, { batch: { coachIds: [] } });
    const batchId = batches[0]!.id;
    expect((await call("PATCH", `/vendor/batches/${batchId}`, owner.token, { coachIds: [teacher.userId.toHexString()] })).statusCode).toBe(200);

    const good = await person({ name: "Ravi Kumar" });
    const poor = await person({ name: "Sita Rao" });
    const goodOrder = await enrolPaid(good, batchId);
    const poorOrder = await enrolPaid(poor, batchId);

    const desk = (await call("GET", "/coaching/desk/batches", teacher.token)).json().data;
    expect(desk).toMatchObject([{ id: batchId, role: "coach", students: 2, can: { attendance: true, message: false, reschedule: false } }]);
    const detail = (await call("GET", `/coaching/desk/batches/${batchId}`, teacher.token)).json().data;
    const classIds = detail.classes.map((c: { id: string }) => c.id) as string[];
    const early = await call("PUT", `/coaching/desk/classes/${classIds[0]}/attendance`, teacher.token, { marks: [{ orderId: goodOrder.id, present: true }] });
    expect(early.json().error.message).toBe("Attendance opens 30 minutes before the class.");

    const last = (await stack.db.coachingBatches.findOne({ _id: new ObjectId(batchId) }))!;
    await shift(batchId, last.lastEndsAt.getTime() - Date.now() + 60_000);
    for (const [i, id] of classIds.entries()) {
      const marked = await call("PUT", `/coaching/desk/classes/${id}/attendance`, teacher.token, {
        marks: [
          { orderId: goodOrder.id, present: i < 3 },
          { orderId: poorOrder.id, present: i < 2 },
        ],
      });
      expect(marked.statusCode).toBe(200);
    }
    const roster = (await call("GET", `/coaching/desk/classes/${classIds[0]}`, teacher.token)).json().data;
    expect(roster).toMatchObject({ class: { marked: true, present: 2 }, students: [{ present: true }, { present: true }] });
    const students = (await call("GET", `/coaching/desk/batches/${batchId}/students`, teacher.token)).json().data;
    expect(students.map((s: { name: string; percent: number }) => [s.name, s.percent])).toEqual([["Ravi Kumar", 75], ["Sita Rao", 50]]);

    const swept = (await sweep()).json();
    expect(swept.coachingCertificates).toBe(1);
    const certs = (await call("GET", "/coaching/certificates", good.token)).json().data;
    expect(certs).toMatchObject([{ studentName: "Ravi Kumar", courseTitle: "Class 10 Maths", attended: 3, classes: 4 }]);
    expect((await call("GET", "/coaching/certificates", poor.token)).json().data).toEqual([]);
    const view = (await call("GET", `/coaching/orders/${goodOrder.id}`, good.token)).json().data;
    expect(view).toMatchObject({ attendance: { attended: 3, held: 4, percent: 75 }, certificate: { code: certs[0].code } });
    const url = new URL(certs[0].pdfUrl);
    const pdf = await stack.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const closed = await call("PUT", `/coaching/desk/classes/${classIds[0]}/attendance`, teacher.token, { marks: [{ orderId: poorOrder.id, present: true }] });
    expect(closed.json().error.message).toBe("Certificates are issued, so attendance is closed.");
  });

  it("cancels, moves and adds classes, telling every student, and refunds demo students of a cancelled class", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { id, batches } = await course(owner, bizId, { course: { demo: { fee: 0, seats: 2 } } });
    const batchId = batches[0]!.id;
    const student = await person();
    const order = await enrolPaid(student, batchId);
    const classes = (await call("GET", `/coaching/desk/batches/${batchId}`, owner.token)).json().data.classes as { id: string; startsAt: string }[];
    const visitor = await person();
    const demo = (await call("POST", `/coaching/${id}/demo`, visitor.token, { sessionId: classes[1]!.id, student: { childId: null }, returnTo: BACK })).json().data.order;

    const cancelled = await call("POST", `/coaching/desk/classes/${classes[1]!.id}/cancel`, owner.token, { reason: "The teacher is unwell." });
    expect(cancelled.json().data.classes[1]).toMatchObject({ status: "cancelled", cancelReason: "The teacher is unwell." });
    expect((await notesFor(student.userId)).at(-1)).toMatchObject({ title: "Class cancelled: Class 10 Maths", type: "coaching.updated" });
    expect((await stack.db.coachingOrders.findOne({ _id: new ObjectId(demo.id as string) }))!.status).toBe("cancelled");
    expect((await notesFor(visitor.userId)).some((x) => x.title.includes("demo class cancelled"))).toBe(true);

    const newStart = new Date(new Date(classes[0]!.startsAt).getTime() - 2 * HOUR);
    const moved = await call("POST", `/coaching/desk/classes/${classes[0]!.id}/move`, owner.token, { startsAt: newStart.toISOString(), reason: "Hall booked later." });
    expect(moved.json().data.classes[0]).toMatchObject({ startsAt: newStart.toISOString(), movedFrom: classes[0]!.startsAt });
    expect((await notesFor(student.userId)).at(-1)!.title).toBe("Class moved: Class 10 Maths");
    const placed = (await stack.db.coachingOrders.findOne({ _id: new ObjectId(order.id) }))!;
    expect(placed.firstAt.toISOString()).toBe(newStart.toISOString());
    expect(placed.releaseAt!.toISOString()).toBe(new Date(newStart.getTime() + HOUR).toISOString());
    const onTop = await call("POST", `/coaching/desk/classes/${classes[2]!.id}/move`, owner.token, { startsAt: classes[3]!.startsAt });
    expect(onTop.json().error.message).toBe("Another class of this batch is at that time.");

    const extraAt = new Date(new Date(classes[3]!.startsAt).getTime() + DAY);
    const extra = await call("POST", `/coaching/desk/batches/${batchId}/classes`, owner.token, { startsAt: extraAt.toISOString(), minutes: 90 });
    expect(extra.statusCode).toBe(201);
    expect(extra.json().data.classes.at(-1)).toMatchObject({ extra: true, status: "upcoming" });
    expect((await notesFor(student.userId)).at(-1)!.title).toBe("Extra class: Class 10 Maths");
    const view = (await call("GET", `/coaching/orders/${order.id}`, student.token)).json().data;
    expect(view.classes.map((c: { status: string }) => c.status)).toEqual(["upcoming", "cancelled", "upcoming", "upcoming", "upcoming"]);
    expect(view.refund).toBeNull();

    const message = await call("POST", `/coaching/desk/batches/${batchId}/messages`, owner.token, { text: "Bring your geometry box tomorrow." });
    expect(message.statusCode).toBe(201);
    expect((await call("GET", `/coaching/orders/${order.id}/messages`, student.token)).json().data).toMatchObject([{ text: "Bring your geometry box tomorrow.", author: "Asha Rao" }]);
    const material = await call("POST", `/coaching/desk/batches/${batchId}/materials`, owner.token, { title: "Formula sheet", url: "https://example.com/formulas" });
    expect(material.statusCode).toBe(201);
    expect((await call("GET", `/coaching/orders/${order.id}/materials`, student.token)).json().data).toMatchObject([{ title: "Formula sheet", kind: "link" }]);
  });

  it("cancels a batch short of its minimum and refunds everyone in full", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { batches } = await course(owner, bizId, { batch: { minStudents: 3 } });
    const batchId = batches[0]!.id;
    const customer = await person();
    const order = await enrolPaid(customer, batchId);
    expect((await sweep()).json().coachingMinimums).toBe(0);

    const batch = (await stack.db.coachingBatches.findOne({ _id: new ObjectId(batchId) }))!;
    await shift(batchId, batch.firstAt.getTime() - Date.now() - 12 * HOUR);
    expect((await sweep()).json().coachingMinimums).toBe(1);
    const after = (await stack.db.coachingBatches.findOne({ _id: new ObjectId(batchId) }))!;
    expect(after).toMatchObject({ status: "cancelled", cancellation: { by: "system" } });
    const placed = (await call("GET", `/coaching/orders/${order.id}`, customer.token)).json().data;
    expect(placed).toMatchObject({ status: "cancelled", refund: { amount: 300_500, status: "done" }, batch: { cancelled: true } });
    expect((await notesFor(customer.userId)).at(-1)!.body).toContain("refunded in full");
    expect((await notesFor(owner.userId)).at(-1)!.title).toBe("Batch cancelled: Class 10 Maths, Morning batch");
    expect(await stack.db.coachingSessions.countDocuments({ batchId: new ObjectId(batchId), status: "scheduled" })).toBe(0);
  });

  it("refunds only until the first class starts, and releases the money once it ends", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { batches } = await course(owner, bizId);
    const batchId = batches[0]!.id;
    const customer = await person();
    const order = await enrolPaid(customer, batchId);

    await pastFirstClass(batchId, { started: true });
    const late = await call("POST", `/coaching/orders/${order.id}/cancel`, customer.token);
    expect(late.json().error).toMatchObject({ code: "ORDER_STATE", message: "Refunds stop once the first class starts." });
    expect((await call("POST", `/vendor/batches/${batchId}/cancel`, owner.token, { reason: "Not enough rooms." })).json().error.message).toBe(
      "This batch has started. Cancel single classes instead.",
    );
    expect((await enrol(await person(), batchId)).json().error.message).toBe("Enrolment closed when this batch started.");

    const before = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(before.balance).toMatchObject({ available: 0, pending: 270_000 });
    await pastFirstClass(batchId);
    const paid = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(paid.balance).toMatchObject({ available: 270_000, pending: 0 });
    const statement = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(statement.map((l: { kind: string; module: string }) => [l.kind, l.module])).toEqual([
      ["available", "coaching"],
      ["paid", "coaching"],
    ]);
  });

  it("lets a vendor cancel a batch before it starts, refunding every student", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { id, batches } = await course(owner, bizId);
    const customer = await person();
    const order = await enrolPaid(customer, batches[0]!.id);
    const res = await call("POST", `/vendor/batches/${batches[0]!.id}/cancel`, owner.token, { reason: "The hall is closed for repairs." });
    expect(res.json().data.batches[0]).toMatchObject({ status: "cancelled", cancelReason: "The hall is closed for repairs." });
    expect((await stack.db.coachingOrders.findOne({ _id: new ObjectId(order.id) }))!.refund).toMatchObject({ amount: 300_500, by: "vendor" });
    expect((await notesFor(customer.userId)).at(-1)).toMatchObject({ title: "Cancelled: Class 10 Maths, Morning batch" });
    expect((await call("GET", `/coaching/${id}`, customer.token)).json().data.whyNot).toBe("No batch is taking enrolments right now.");
  });

  it("checks team permissions: who teaches the batch, what the owner gave them, and verification", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const viewer = await teamMember(owner, bizId, ["classes.view"]);
    const other = await teamMember(owner, bizId, ["classes.view", "classes.reschedule"]);
    const unverified = await teamMember(owner, bizId, ["classes.view"], false);
    const { batches } = await course(owner, bizId, { batch: { coachIds: [] } });
    const batchId = batches[0]!.id;
    await call("PATCH", `/vendor/batches/${batchId}`, owner.token, { coachIds: [viewer.userId.toHexString(), unverified.userId.toHexString()] });
    const outsider = await person();
    expect((await call("PATCH", `/vendor/batches/${batchId}`, owner.token, { coachIds: [outsider.userId.toHexString()] })).json().error.details[0].path).toBe("body/coachIds/0");

    const classes = (await call("GET", `/coaching/desk/batches/${batchId}`, viewer.token)).json().data.classes as { id: string }[];
    expect(classes).toHaveLength(4);
    expect((await call("POST", `/coaching/desk/classes/${classes[0]!.id}/cancel`, viewer.token, { reason: "Rain today." })).statusCode).toBe(403);
    expect((await call("POST", `/coaching/desk/batches/${batchId}/messages`, viewer.token, { text: "Hello" })).statusCode).toBe(403);
    expect((await call("GET", `/coaching/desk/batches/${batchId}`, other.token)).json().error).toMatchObject({ code: "FORBIDDEN", message: "You don't teach this batch." });
    expect((await call("GET", `/coaching/desk/batches/${batchId}`, unverified.token)).json().error.code).toBe("KYC_REQUIRED");
    expect((await call("GET", `/coaching/desk/batches/${batchId}`, outsider.token)).statusCode).toBe(404);
    expect((await call("GET", "/coaching/desk/batches", unverified.token)).json().data).toEqual([]);
    expect((await call("POST", `/vendor/courses/${batches[0]!.id}/batches`, viewer.token, batchBody())).statusCode).toBe(403);

    await call("PATCH", `/vendor/batches/${batchId}`, owner.token, { coachIds: [other.userId.toHexString()] });
    const moved = await call("POST", `/coaching/desk/classes/${classes[2]!.id}/cancel`, other.token, { reason: "Exam hall booked." });
    expect(moved.statusCode).toBe(200);
    expect((await notesFor(owner.userId)).at(-1)!.title).toBe("Class cancelled: Class 10 Maths");
  });

  it("lets the console list courses, take one down refunding paid students, and set coaching rules, audited", async () => {
    const owner = await coach();
    const bizId = await business(owner);
    const { id, batches } = await course(owner, bizId);
    const customer = await person();
    const order = await enrolPaid(customer, batches[0]!.id);
    const viewer = await staff(["businesses.view"]);
    const manager = await staff(["businesses.view", "businesses.manage", "modules.view", "modules.manage"]);

    expect((await call("GET", "/ruxstar/coaching/courses?status=live", viewer.token)).json().data).toMatchObject([{ id, counts: { students: 1 }, money: { sales: 300_000 } }]);
    expect((await call("POST", `/ruxstar/coaching/courses/${id}/take-down`, viewer.token, { reason: "Misleading claims." })).statusCode).toBe(403);
    const down = await call("POST", `/ruxstar/coaching/courses/${id}/take-down`, manager.token, { reason: "Misleading results claims." });
    expect(down.json().data).toMatchObject({ status: "removed", removal: { reason: "Misleading results claims." }, batches: [{ status: "cancelled" }] });
    expect((await stack.db.coachingOrders.findOne({ _id: new ObjectId(order.id) }))!).toMatchObject({ status: "cancelled", refund: { amount: 300_500, by: "staff" } });
    expect((await notesFor(owner.userId)).at(-1)!.title).toBe("Ruxstar took down Class 10 Maths");
    expect((await call("GET", "/coaching", customer.token)).json().data).toEqual([]);
    expect(await stack.db.auditLogs.countDocuments({ action: "coaching_course.take_down" })).toBe(1);

    const settings = await call("PATCH", "/ruxstar/modules/coaching", manager.token, { coachingRules: { certificatePercent: 80 } });
    expect(settings.json().data.coachingRules).toMatchObject({ certificatePercent: 80, minimumHours: 24, maxDemoSeats: 5 });
    expect((await call("PATCH", "/ruxstar/modules/events", manager.token, { coachingRules: { certificatePercent: 80 } })).json().error.message).toBe(
      "Coaching rules are set on the coaching module.",
    );
    expect(await stack.db.auditLogs.countDocuments({ action: "module_settings.update" })).toBe(1);
    const rules = (await call("GET", "/coaching/rules", customer.token)).json().data;
    expect(rules).toMatchObject({ certificatePercent: 80, commissionBps: 1000, platformFee: 500 });
  });
});
