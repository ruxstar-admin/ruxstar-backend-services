import { MongoBulkWriteError } from "mongodb";
import type { Database, ModuleSettingsDoc, SwitchableModule } from "./db.js";
import { stamp } from "./db.js";

export const SWITCHABLE_MODULES: readonly SwitchableModule[] = ["pod", "events", "coaching", "stays", "turf", "shop", "delivery", "ledger"];
/** Notifications are deleted after this many days. */
export const NOTIFICATION_DAYS = 90;

export async function ensurePlatformIndexes(db: Database): Promise<void> {
  await Promise.all([
    db.moduleSettings.createIndex({ module: 1 }, { unique: true }),
    db.ruxstarStaff.createIndex({ userId: 1 }, { unique: true }),
    db.platformSettings.createIndex({ key: 1 }, { unique: true }),
    db.users.createIndex({ phone: 1 }, { unique: true }),
    ensureVerifiedEmailIndex(db),
    db.users.createIndex({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: "string" } } }),
    db.users.createIndex({ status: 1 }),
    db.users.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),
    db.sessions.createIndex({ userId: 1, revokedAt: 1 }),
    db.sessions.createIndex(
      { refreshTokenHash: 1 },
      { unique: true, partialFilterExpression: { refreshTokenHash: { $type: "string" } } },
    ),
    db.sessions.createIndex({ prevRefreshTokenHash: 1 }, { partialFilterExpression: { prevRefreshTokenHash: { $type: "string" } } }),
    db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.sessions.createIndex({ pushToken: 1 }, { partialFilterExpression: { pushToken: { $type: "string" } } }),
    db.otps.createIndex({ target: 1, purpose: 1 }, { unique: true }),
    db.otps.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // A business's activity for its owner, everyone's or one person's.
    db.auditLogs.createIndex({ "scope.businessId": 1, at: -1, _id: -1 }),
    db.auditLogs.createIndex({ "scope.businessId": 1, "actor.id": 1, at: -1, _id: -1 }),
    db.auditLogs.createIndex({ "scope.module": 1, at: -1 }),
    db.auditLogs.createIndex({ "actor.id": 1, at: -1 }),
    db.auditLogs.createIndex({ "target.id": 1, at: -1 }),
    // The admin audit log: everything newest first, or one action.
    db.auditLogs.createIndex({ at: -1, _id: -1 }),
    db.auditLogs.createIndex({ action: 1, at: -1, _id: -1 }),
    db.idempotencyKeys.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.users.createIndex({ createdAt: -1, _id: -1 }),
    // The feed, and one person's posts on one tab.
    db.posts.createIndex({ status: 1, createdAt: -1, _id: -1 }),
    db.posts.createIndex({ authorId: 1, kind: 1, status: 1, createdAt: -1, _id: -1 }),
    db.postMedia.createIndex({ userId: 1, postId: 1, createdAt: 1 }),
    // Releasing and deleting a post's photos.
    db.postMedia.createIndex({ postId: 1 }),
    db.postReactions.createIndex({ postId: 1, userId: 1, kind: 1 }, { unique: true }),
    db.postReactions.createIndex({ userId: 1, kind: 1, createdAt: -1, _id: -1 }),
    db.postComments.createIndex({ postId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.reports.createIndex({ "target.id": 1, userId: 1 }, { unique: true }),
    db.reports.createIndex({ status: 1, createdAt: -1 }),
    db.reports.createIndex({ "target.id": 1, status: 1 }),
    // Follower and following lists, newest first, and the Following feed's author list.
    db.follows.createIndex({ followerId: 1, followeeId: 1 }, { unique: true }),
    db.follows.createIndex({ followeeId: 1, createdAt: -1, _id: -1 }),
    db.follows.createIndex({ followerId: 1, createdAt: -1, _id: -1 }),
    db.blocks.createIndex({ blockerId: 1, blockedId: 1 }, { unique: true }),
    db.blocks.createIndex({ blockerId: 1, createdAt: -1, _id: -1 }),
    db.blocks.createIndex({ blockedId: 1 }),
    db.userReports.createIndex({ userId: 1, reporterId: 1, status: 1 }),
    db.userReports.createIndex({ status: 1, createdAt: -1 }),
    db.posts.createIndex({ authorId: 1, status: 1, createdAt: -1, _id: -1 }),
    // Chats: one 1:1 chat per pair, each person's chat list newest first (chats and requests), and a chat's
    // messages newest first, plus what was unsent since a poll.
    db.conversations.createIndex({ pairKey: 1 }, { unique: true, partialFilterExpression: { pairKey: { $type: "string" } } }),
    db.chatMembers.createIndex({ conversationId: 1, userId: 1 }, { unique: true }),
    db.chatMembers.createIndex({ userId: 1, state: 1, lastAt: -1, _id: -1 }),
    db.chatMessages.createIndex({ conversationId: 1, createdAt: -1, _id: -1 }),
    db.chatMessages.createIndex({ conversationId: 1, unsentAt: 1 }, { partialFilterExpression: { status: "unsent" } }),
    db.chatMessages.createIndex({ conversationId: 1, touchedAt: 1 }, { partialFilterExpression: { touchedAt: { $type: "date" } } }),
    db.chatMessages.createIndex({ senderId: 1 }),
    db.notifications.createIndex({ userId: 1, createdAt: -1, _id: -1 }),
    db.notifications.createIndex({ userId: 1, readAt: 1 }),
    db.notifications.createIndex({ userId: 1, type: 1, "link.id": 1, actorId: 1 }),
    db.notifications.createIndex({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_DAYS * 24 * 60 * 60 }),
    db.kycCases.createIndex({ userId: 1, track: 1 }, { unique: true }),
    // The review queue, by status, newest activity first.
    db.kycCases.createIndex({ status: 1, updatedAt: -1, _id: -1 }),
    db.kycCases.createIndex({ status: 1, track: 1, updatedAt: -1, _id: -1 }),
    db.kycCases.createIndex({ "steps.pan.hash": 1 }, { partialFilterExpression: { "steps.pan.hash": { $type: "string" } } }),
    db.users.createIndex({ "card.id": 1 }, { unique: true, partialFilterExpression: { "card.id": { $type: "string" } } }),
    // A vendor's own businesses, and the console's list: everything, or one module or status.
    db.businesses.createIndex({ ownerId: 1, createdAt: -1 }),
    db.businesses.createIndex({ updatedAt: -1, _id: -1 }),
    db.businesses.createIndex({ module: 1, status: 1, updatedAt: -1, _id: -1 }),
    db.businesses.createIndex({ module: 1, status: 1, publishedAt: -1, _id: -1 }),
    db.businesses.createIndex({ status: 1, updatedAt: -1, _id: -1 }),
    db.payoutMethods.createIndex({ userId: 1 }, { unique: true }),
    db.riderPayoutMethods.createIndex({ userId: 1 }, { unique: true }),
    db.payouts.createIndex({ vendorId: 1, createdAt: -1, _id: -1 }),
    // One withdrawal on the way per person, vendor or partner, so two taps at once can't both take the balance.
    db.payouts.createIndex({ vendorId: 1 }, { name: "one_pending_payout", unique: true, partialFilterExpression: { status: "pending" } }),
    db.payouts.createIndex({ status: 1, checkedAt: 1 }),
    db.payouts.createIndex({ status: 1, createdAt: -1, _id: -1 }),
    db.printFiles.createIndex({ userId: 1, orderId: 1, createdAt: 1 }),
    // A customer's orders, a shop's orders (all, or one status), and finding an order from Cashfree's id.
    db.podOrders.createIndex({ orderNo: 1 }, { unique: true }),
    db.podOrders.createIndex({ customerId: 1, createdAt: -1, _id: -1 }),
    db.podOrders.createIndex({ vendorId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.podOrders.createIndex({ shopId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.podOrders.createIndex({ "payment.gatewayOrderId": 1 }, { unique: true }),
    // The order timers: not accepted in time, long past the ready date, the shop's share due, refunds to retry.
    db.podOrders.createIndex({ status: 1, acceptBy: 1 }),
    db.podOrders.createIndex({ status: 1, readyBy: 1 }),
    db.podOrders.createIndex({ status: 1, releaseAt: 1 }),
    db.podOrders.createIndex({ status: 1, releasedAt: 1, releaseAt: -1, _id: -1 }),
    db.podOrders.createIndex({ "refunds.status": 1 }, { partialFilterExpression: { "refunds.status": "pending" } }),
    // The console's order problems, open or settled, newest first.
    db.podOrders.createIndex({ "problem.status": 1, problemAt: -1, _id: -1 }),
    // Coupons: one per code; the console's lists (Ruxstar's or vendors'), a vendor's own, and the offers for a shop.
    db.coupons.createIndex({ code: 1 }, { unique: true }),
    db.coupons.createIndex({ fundedBy: 1, createdAt: -1, _id: -1 }),
    db.coupons.createIndex({ vendorId: 1, createdAt: -1, _id: -1 }),
    db.coupons.createIndex({ active: 1, listed: 1, fundedBy: 1, businessIds: 1 }),
    // One use per order, and a customer's uses of a coupon.
    db.couponRedemptions.createIndex({ orderId: 1 }, { unique: true }),
    db.couponRedemptions.createIndex({ couponId: 1, customerId: 1 }),
    // Teams: one open place per person per business, a business's team, and someone's invites and places.
    db.employments.createIndex({ businessId: 1, userId: 1 }, { name: "one_place_per_business", unique: true, partialFilterExpression: { current: true } }),
    db.employments.createIndex({ businessId: 1, current: 1, invitedAt: 1 }),
    db.employments.createIndex({ userId: 1, current: 1, invitedAt: -1 }),
    // Reviews of every module: one per order, a business's live reviews newest first, and an event's or course's.
    // Review reports: one open per person, and the console's queue.
    db.reviews.createIndex({ orderId: 1 }, { unique: true }),
    db.reviews.createIndex({ shopId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.reviews.createIndex({ "listing.id": 1, status: 1, createdAt: -1, _id: -1 }, { partialFilterExpression: { "listing.id": { $exists: true } } }),
    db.reviewReports.createIndex({ reviewId: 1, reporterId: 1, status: 1 }),
    db.reviewReports.createIndex({ status: 1, createdAt: -1 }),
    // One entry per account and bucket in a transaction, so a money move can't be written twice.
    db.ledgerEntries.createIndex({ txnId: 1, accountId: 1, bucket: 1 }, { unique: true }),
    db.ledgerEntries.createIndex({ accountId: 1, bucket: 1 }),
    db.ledgerEntries.createIndex({ accountId: 1, at: -1, _id: -1 }),
    // Deliveries: an order's trips, a rider's trips newest first, the offers in a city, one trip under way per rider, and map
    // routes running out.
    db.deliveryJobs.createIndex({ orderId: 1, createdAt: -1 }),
    db.deliveryJobs.createIndex({ riderId: 1, status: 1, updatedAt: -1, _id: -1 }),
    db.deliveryJobs.createIndex({ status: 1, carrier: 1, city: 1, offerUntil: 1 }),
    db.deliveryJobs.createIndex({ riderId: 1 }, { name: "one_trip_per_rider", unique: true, partialFilterExpression: { busy: true } }),
    db.riderStates.createIndex({ online: 1, city: 1 }),
    db.deliveryRoutes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.podOrders.createIndex({ "delivery.status": 1, "delivery.offerUntil": 1 }, { partialFilterExpression: { "delivery.status": "offered" } }),
    // Partners' pay on hold: all of it coming due, and one partner's.
    db.podOrders.createIndex({ "delivery.releasedAt": 1, "delivery.releaseAt": 1 }, { partialFilterExpression: { "delivery.releaseAt": { $type: "date" } } }),
    db.podOrders.createIndex(
      { "delivery.rider.id": 1, "delivery.releasedAt": 1, "delivery.releaseAt": 1 },
      { partialFilterExpression: { "delivery.releaseAt": { $type: "date" } } },
    ),
    // Support: one number per ticket, a person's tickets, the console's queue (by status, topic or assignee) and its overdue count.
    db.supportTickets.createIndex({ ticketNo: 1 }, { unique: true }),
    db.supportTickets.createIndex({ requesterId: 1, lastAt: -1, _id: -1 }),
    db.supportTickets.createIndex({ status: 1, lastAt: -1, _id: -1 }),
    db.supportTickets.createIndex({ status: 1, category: 1, lastAt: -1, _id: -1 }),
    db.supportTickets.createIndex({ assigneeId: 1, status: 1, lastAt: -1, _id: -1 }),
    db.supportTickets.createIndex({ status: 1, slaDueAt: 1 }),
    db.supportMessages.createIndex({ ticketId: 1, at: 1 }),
    // Events: a business's, what's on (by start), and those cancelled lately for the refunds sweep.
    db.events.createIndex({ businessId: 1, startsAt: -1 }),
    db.events.createIndex({ status: 1, startsAt: 1, _id: 1 }),
    db.events.createIndex({ status: 1, "cancellation.at": -1 }),
    db.eventOrders.createIndex({ orderNo: 1 }, { unique: true }),
    db.eventOrders.createIndex({ "payment.gatewayOrderId": 1 }, { unique: true, partialFilterExpression: { "payment.gatewayOrderId": { $type: "string" } } }),
    db.eventOrders.createIndex({ customerId: 1, startsAt: -1, _id: -1 }),
    db.eventOrders.createIndex({ customerId: 1, eventId: 1 }),
    db.eventOrders.createIndex({ eventId: 1, status: 1, createdAt: -1, _id: -1 }),
    // The ticket timers: unpaid holds, shares coming due, refunds to retry.
    db.eventOrders.createIndex({ status: 1, holdUntil: 1 }),
    db.eventOrders.createIndex({ status: 1, releasedAt: 1, releaseAt: 1 }),
    db.eventOrders.createIndex({ vendorId: 1, status: 1, releasedAt: 1 }),
    db.eventOrders.createIndex({ "refund.status": 1 }, { partialFilterExpression: { "refund.status": "pending" } }),
    db.eventTickets.createIndex({ eventId: 1, code: 1 }, { unique: true }),
    db.eventTickets.createIndex({ hash: 1 }, { unique: true }),
    db.eventTickets.createIndex({ orderId: 1 }),
    db.eventTickets.createIndex({ eventId: 1, status: 1, "checkIns.day": 1 }),
    db.eventTickets.createIndex({ eventId: 1, "holder.phone": 1 }),
    db.eventTickets.createIndex({ eventId: 1, status: 1, createdAt: -1, _id: -1 }),
    // The waitlist: one open place per person and ticket type, the queue in order, and offers running out.
    db.eventWaits.createIndex({ eventId: 1, tierId: 1, customerId: 1 }, { unique: true, partialFilterExpression: { open: true } }),
    db.eventWaits.createIndex({ eventId: 1, tierId: 1, status: 1, createdAt: 1 }),
    db.eventWaits.createIndex({ customerId: 1, eventId: 1 }),
    db.eventWaits.createIndex({ status: 1, offeredUntil: 1 }),
    // Coaching: listings by city and category, a business's courses, batches of a course and the minimum and certificate
    // timers, a batch's classes in order and the day's classes, and attendance once per class and student.
    db.coachingCourses.createIndex({ status: 1, publishedAt: -1, _id: -1 }),
    db.coachingCourses.createIndex({ status: 1, city: 1, publishedAt: -1, _id: -1 }),
    db.coachingCourses.createIndex({ status: 1, category: 1, publishedAt: -1, _id: -1 }),
    db.coachingCourses.createIndex({ businessId: 1, createdAt: -1 }),
    db.coachingCourses.createIndex({ createdAt: -1, _id: -1 }),
    db.coachingBatches.createIndex({ courseId: 1, status: 1, firstAt: 1 }),
    db.coachingBatches.createIndex({ businessId: 1, status: 1, lastEndsAt: 1 }),
    db.coachingBatches.createIndex({ status: 1, minimumCheckedAt: 1, firstAt: 1 }, { partialFilterExpression: { minStudents: { $type: "number" } } }),
    db.coachingBatches.createIndex({ status: 1, certificatesAt: 1, lastEndsAt: 1 }),
    db.coachingBatches.createIndex({ status: 1, "cancellation.at": 1 }),
    db.coachingSessions.createIndex({ batchId: 1, startsAt: 1 }),
    db.coachingSessions.createIndex({ courseId: 1 }),
    db.coachingSessions.createIndex({ startsAt: 1 }),
    // Places: one open place per student and batch, and one demo per student and course; the payment and timers; the
    // customer's lists; a course's and batch's students; and the institute's money.
    db.coachingOrders.createIndex({ orderNo: 1 }, { unique: true }),
    db.coachingOrders.createIndex({ seat: 1 }, { unique: true, partialFilterExpression: { seat: { $type: "string" } } }),
    db.coachingOrders.createIndex({ "payment.gatewayOrderId": 1 }, { unique: true, partialFilterExpression: { "payment.gatewayOrderId": { $type: "string" } } }),
    db.coachingOrders.createIndex({ customerId: 1, status: 1, firstAt: 1 }),
    db.coachingOrders.createIndex({ customerId: 1, createdAt: -1, _id: -1 }),
    db.coachingOrders.createIndex({ customerId: 1, courseId: 1 }),
    db.coachingOrders.createIndex({ courseId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.coachingOrders.createIndex({ batchId: 1, status: 1, kind: 1 }),
    db.coachingOrders.createIndex({ sessionId: 1, status: 1 }, { partialFilterExpression: { sessionId: { $type: "objectId" } } }),
    db.coachingOrders.createIndex({ "student.childId": 1, status: 1 }, { partialFilterExpression: { "student.childId": { $type: "objectId" } } }),
    db.coachingOrders.createIndex({ status: 1, holdUntil: 1 }),
    db.coachingOrders.createIndex({ status: 1, releasedAt: 1, releaseAt: 1 }),
    db.coachingOrders.createIndex({ vendorId: 1, status: 1, releasedAt: 1 }),
    db.coachingOrders.createIndex({ "refund.status": 1 }, { partialFilterExpression: { "refund.status": "pending" } }),
    db.coachingChildren.createIndex({ parentId: 1, createdAt: 1 }),
    db.coachingAttendance.createIndex({ sessionId: 1, orderId: 1 }, { unique: true }),
    db.coachingAttendance.createIndex({ orderId: 1 }),
    db.coachingMaterials.createIndex({ courseId: 1, batchId: 1, createdAt: -1 }),
    db.coachingMessages.createIndex({ batchId: 1, at: -1 }),
    db.coachingCertificates.createIndex({ orderId: 1 }, { unique: true }),
    db.coachingCertificates.createIndex({ customerId: 1, issuedAt: -1 }),
    // Turf: listings by city and sport, a business's grounds, the console's list, a ground's courts, and the sports list.
    db.turfGrounds.createIndex({ status: 1, publishedAt: -1, _id: -1 }),
    db.turfGrounds.createIndex({ status: 1, city: 1, publishedAt: -1, _id: -1 }),
    db.turfGrounds.createIndex({ status: 1, sports: 1, publishedAt: -1, _id: -1 }),
    db.turfGrounds.createIndex({ businessId: 1, createdAt: 1 }),
    db.turfGrounds.createIndex({ createdAt: -1, _id: -1 }),
    db.turfGrounds.createIndex({ status: 1, createdAt: -1, _id: -1 }),
    db.turfCourts.createIndex({ groundId: 1, order: 1 }),
    db.turfSports.createIndex({ active: 1, order: 1 }),
    // Slots: one document per court and start, which is what stops a double booking; a ground's day; a booking's slots;
    // holds running out.
    db.turfSlots.createIndex({ courtId: 1, startAt: 1 }, { unique: true }),
    db.turfSlots.createIndex({ groundId: 1, startAt: 1 }),
    db.turfSlots.createIndex({ bookingId: 1 }, { partialFilterExpression: { bookingId: { $type: "objectId" } } }),
    db.turfSlots.createIndex({ status: 1, holdUntil: 1 }, { partialFilterExpression: { status: "held" } }),
    // Bookings: the payment, the customer's lists, a ground's and business's, a court's upcoming, and the timers.
    db.turfBookings.createIndex({ orderNo: 1 }, { unique: true }),
    db.turfBookings.createIndex({ "payment.gatewayOrderId": 1 }, { unique: true, partialFilterExpression: { "payment.gatewayOrderId": { $type: "string" } } }),
    db.turfBookings.createIndex({ customerId: 1, createdAt: -1, _id: -1 }),
    db.turfBookings.createIndex({ customerId: 1, status: 1, lastEndsAt: 1 }),
    db.turfBookings.createIndex({ groundId: 1, createdAt: -1, _id: -1 }),
    db.turfBookings.createIndex({ groundId: 1, status: 1, lastEndsAt: 1 }),
    db.turfBookings.createIndex({ courtId: 1, status: 1, lastEndsAt: 1 }),
    db.turfBookings.createIndex({ businessId: 1, createdAt: -1, _id: -1 }),
    db.turfBookings.createIndex({ status: 1, holdUntil: 1 }),
    db.turfBookings.createIndex({ releaseAt: 1 }, { partialFilterExpression: { releaseAt: { $type: "date" } } }),
    db.turfBookings.createIndex({ vendorId: 1, releaseAt: 1 }, { partialFilterExpression: { releaseAt: { $type: "date" } } }),
    db.turfBookings.createIndex({ "refunds.status": 1 }, { partialFilterExpression: { "refunds.status": "pending" } }),
    // Stays: live properties newest first (all, or one city), a business's properties, rooms and beds of a property, and
    // reservations by number, payment, bed (the overlap check), customer, property, timers and money owed back.
    db.staysProperties.createIndex({ status: 1, publishedAt: -1, _id: -1 }),
    db.staysProperties.createIndex({ status: 1, city: 1, publishedAt: -1, _id: -1 }),
    db.staysProperties.createIndex({ businessId: 1, createdAt: 1 }),
    db.staysProperties.createIndex({ createdAt: -1, _id: -1 }),
    db.staysRooms.createIndex({ propertyId: 1, order: 1 }),
    db.staysBeds.createIndex({ roomId: 1, order: 1 }),
    db.staysBeds.createIndex({ propertyId: 1 }),
    db.staysReservations.createIndex({ orderNo: 1 }, { unique: true }),
    db.staysReservations.createIndex({ "payment.gatewayOrderId": 1 }, { unique: true, partialFilterExpression: { "payment.gatewayOrderId": { $type: "string" } } }),
    db.staysReservations.createIndex({ bedIds: 1, status: 1 }),
    db.staysReservations.createIndex({ customerId: 1, createdAt: -1, _id: -1 }),
    db.staysReservations.createIndex({ propertyId: 1, createdAt: -1, _id: -1 }),
    db.staysReservations.createIndex({ propertyId: 1, status: 1, from: 1 }),
    db.staysReservations.createIndex({ status: 1, holdUntil: 1 }),
    db.staysReservations.createIndex({ releaseAt: 1 }, { partialFilterExpression: { releaseAt: { $type: "date" } } }),
    db.staysReservations.createIndex({ "refund.status": 1 }, { partialFilterExpression: { "refund.status": "pending" } }),
    db.staysReservations.createIndex({ "objection.status": 1, "objection.at": -1 }, { partialFilterExpression: { "objection.status": "open" } }),
    // Local shops: live products of a city (newest first, or a shop's), a business's products, the console's list; orders by
    // number, payment, customer, shop and status, the timers (holds, acceptance, release), refunds to retry, open returns,
    // and partner trips and their pay, as for print orders.
    db.shopProducts.createIndex({ status: 1, city: 1, createdAt: -1, _id: -1 }),
    db.shopProducts.createIndex({ businessId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.shopProducts.createIndex({ createdAt: -1, _id: -1 }),
    db.shopOrders.createIndex({ orderNo: 1 }, { unique: true }),
    db.shopOrders.createIndex({ "payment.gatewayOrderId": 1 }, { unique: true }),
    db.shopOrders.createIndex({ customerId: 1, createdAt: -1, _id: -1 }),
    db.shopOrders.createIndex({ businessId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.shopOrders.createIndex({ createdAt: -1, _id: -1 }),
    db.shopOrders.createIndex({ status: 1, holdUntil: 1 }),
    db.shopOrders.createIndex({ status: 1, acceptBy: 1 }),
    db.shopOrders.createIndex({ releaseAt: 1 }, { partialFilterExpression: { releaseAt: { $type: "date" } } }),
    db.shopOrders.createIndex({ vendorId: 1, releaseAt: 1 }, { partialFilterExpression: { releaseAt: { $type: "date" } } }),
    db.shopOrders.createIndex({ "refunds.status": 1 }, { partialFilterExpression: { "refunds.status": "pending" } }),
    db.shopOrders.createIndex({ "return.status": 1, "return.requestedAt": -1 }, { partialFilterExpression: { "return.status": { $type: "string" } } }),
    db.shopOrders.createIndex({ "delivery.status": 1, "delivery.offerUntil": 1 }, { partialFilterExpression: { "delivery.status": "offered" } }),
    db.shopOrders.createIndex({ "delivery.releasedAt": 1, "delivery.releaseAt": 1 }, { partialFilterExpression: { "delivery.releaseAt": { $type: "date" } } }),
    db.shopOrders.createIndex(
      { "delivery.rider.id": 1, "delivery.releasedAt": 1, "delivery.releaseAt": 1 },
      { partialFilterExpression: { "delivery.releaseAt": { $type: "date" } } },
    ),
    // GST documents: one per order part or refund, numbers unique per series, an order's documents, and the lists for
    // customers, vendors (all businesses or one) and the console (everything, one kind, or found by number or order),
    // each also by module. The `from`/`to` filters are ranges on `issuedAt`, the sort key, so they use the same indexes.
    db.invoices.createIndex({ key: 1 }, { unique: true }),
    db.invoices.createIndex({ series: 1, number: 1 }, { unique: true }),
    db.invoices.createIndex({ "source.id": 1, issuedAt: 1 }),
    db.invoices.createIndex({ customerId: 1, issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ customerId: 1, module: 1, issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ vendorId: 1, role: 1, issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ vendorId: 1, role: 1, module: 1, issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ businessId: 1, role: 1, issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ kind: 1, issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ module: 1, issuedAt: -1, _id: -1 }),
    db.invoices.createIndex({ number: 1 }),
    db.invoices.createIndex({ "source.orderNo": 1 }),
    // Console stats: verified people, businesses on hold per module, orders placed today and this week, what's still under way,
    // money through the gateway since the week or month began, pending balances by module (covered), and payout totals (covered).
    db.users.createIndex({ "kyc.base": 1, status: 1 }),
    db.businesses.createIndex({ module: 1, status: 1 }, { name: "held_businesses", partialFilterExpression: { suspension: { $exists: true } } }),
    db.podOrders.createIndex({ createdAt: -1, _id: -1 }),
    db.eventOrders.createIndex({ createdAt: -1, _id: -1 }),
    db.eventOrders.createIndex({ status: 1, endsAt: 1 }),
    db.coachingOrders.createIndex({ createdAt: -1, _id: -1 }),
    db.turfBookings.createIndex({ createdAt: -1, _id: -1 }),
    db.turfBookings.createIndex({ status: 1, lastEndsAt: 1 }),
    db.staysReservations.createIndex({ createdAt: -1, _id: -1 }),
    db.deliveryJobs.createIndex({ createdAt: -1 }),
    db.ledgerEntries.createIndex({ accountId: 1, kind: 1, at: 1 }),
    db.ledgerEntries.createIndex({ bucket: 1, "source.type": 1, accountId: 1, signedPaise: 1 }, { name: "pending_by_source" }),
    db.payouts.createIndex({ status: 1, paidAt: 1, amount: 1 }, { name: "payout_totals" }),
  ]);
}

/** The first version made every email unique; it is rebuilt once to cover verified emails only. */
async function ensureVerifiedEmailIndex(db: Database): Promise<void> {
  const filter = { email: { $type: "string" }, emailVerified: true };
  const existing = (await db.users.indexes().catch(() => [])).find((index) => index.name === "email_1");
  if (existing && JSON.stringify(existing.partialFilterExpression) !== JSON.stringify(filter)) {
    // Two instances starting together may both try; the second finds it already gone.
    await db.users.dropIndex("email_1").catch(() => undefined);
  }
  await db.users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: filter });
}

/**
 * New modules start switched off. Existing settings are never overwritten. When another instance
 * seeds at the same moment, its rows win and the duplicate-key errors here are expected.
 */
export async function seedModuleSettings(db: Database): Promise<void> {
  const now = new Date();
  await db.moduleSettings.bulkWrite(
    SWITCHABLE_MODULES.map((module) => {
      const defaults: Omit<ModuleSettingsDoc, "_id"> = {
        module,
        live: false,
        signupsOpen: false,
        commissionBps: 0,
        platformFee: 0,
        deliveryEnabled: false,
        permissionCatalog: [],
        updatedBy: null,
        ...stamp(now),
      };
      return { updateOne: { filter: { module }, update: { $setOnInsert: defaults }, upsert: true } };
    }),
    { ordered: false },
  ).catch((err: unknown) => {
    const errors = err instanceof MongoBulkWriteError ? [err.writeErrors].flat() : [];
    if (errors.length === 0 || errors.some((e) => e.code !== 11000)) throw err;
  });
}
