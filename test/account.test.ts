import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 120_000);
afterAll(async () => {
  await stack?.stop();
});

const WEB = { "x-client": "web" };
const APP = { "x-client": "app", "x-app-version": "2.1.0" };
let seq = 0;
const newPhone = () => `98${String(Date.now() % 1e6).padStart(6, "0")}${String(seq++ % 100).padStart(2, "0")}`;

const post = (url: string, payload: object, headers: Record<string, string> = WEB, cookies?: Record<string, string>) =>
  stack.app.inject({ method: "POST", url: `/v1/account${url}`, payload, headers, ...(cookies ? { cookies } : {}) });

const cookieMap = (res: { cookies: { name: string; value: string }[] }) =>
  Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));

async function verified(phone: string, purpose: "signup" | "reset" | "login", headers = WEB) {
  const sent = await post("/otp", { phone, purpose }, headers);
  expect(sent.statusCode).toBe(200);
  const code = stack.texts.get(`+91${phone}`)!;
  const res = await post("/otp/verify", { phone, purpose, code }, headers);
  expect(res.statusCode).toBe(200);
  return res.json().data.verificationToken as string;
}

async function signUp(phone = newPhone(), password = "sunrise42", headers = WEB) {
  const verificationToken = await verified(phone, "signup", headers);
  const res = await post("/signup", { verificationToken, name: "Asha  Rao", password, acceptTerms: true }, headers);
  expect(res.statusCode).toBe(201);
  return { phone, password, res };
}

describe("signup", () => {
  it("texts a 6-digit code and masks the number in the reply", async () => {
    const phone = newPhone();
    const sent = await post("/otp", { phone, purpose: "signup" });
    expect(sent.json().data).toEqual({ sentTo: `+91 ••••• •${phone.slice(-4)}`, expiresInSeconds: 600, resendInSeconds: 30 });
    expect(stack.texts.get(`+91${phone}`)).toMatch(/^\d{6}$/);
    expect((await stack.db.otps.findOne({ target: `+91${phone}` }))?.codeHash).not.toContain(stack.texts.get(`+91${phone}`));
  });

  it("returns the user, sets httpOnly cookies and keeps tokens out of the body", async () => {
    const { phone, res } = await signUp();
    const body = res.json();
    expect(body.data.user).toMatchObject({ phone: `+91${phone}`, name: "Asha Rao", kyc: { base: "none" } });
    expect(body.data.user.username).toMatch(/^(asha|asha\.rao|asharao|asha_rao|asha\.r|a\.rao|asha\d{2,4})$/);
    expect(body.data.tokens).toBeUndefined();

    const cookies = res.cookies;
    const at = cookies.find((c) => c.name === "rx_at")!;
    const rt = cookies.find((c) => c.name === "rx_rt")!;
    expect(at.httpOnly).toBe(true);
    expect(at.sameSite).toBe("Lax");
    expect(rt.path).toBe("/v1/account");

    const me = await stack.app.inject({ method: "GET", url: "/v1/account/me", headers: WEB, cookies: { rx_at: at.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.phone).toBe(`+91${phone}`);

    const stored = await stack.db.users.findOne({ phone: `+91${phone}` });
    expect(stored?.passwordHash).toMatch(/^scrypt\$/);
    expect(stored?.consent?.termsVersion).toBeTruthy();
  });

  it("gives the apps tokens in the body", async () => {
    const { res } = await signUp(newPhone(), "sunrise42", APP);
    expect(res.json().data.tokens).toMatchObject({ accessTokenExpiresIn: 900 });
    expect(res.cookies).toHaveLength(0);
  });

  it("refuses a number that already has an account", async () => {
    const { phone } = await signUp();
    const res = await post("/otp", { phone, purpose: "signup" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PHONE_TAKEN");
  });

  it("lets a verification token be used once", async () => {
    const phone = newPhone();
    const verificationToken = await verified(phone, "signup");
    const body = { verificationToken, name: "Ravi", password: "monsoon77", acceptTerms: true };
    expect((await post("/signup", body)).statusCode).toBe(201);
    const again = await post("/signup", body);
    expect(again.json().error.code).toBe("VERIFICATION_INVALID");
  });

  it("rejects weak passwords, missing consent and unknown fields", async () => {
    const verificationToken = await verified(newPhone(), "signup");
    const weak = await post("/signup", { verificationToken, name: "Ravi", password: "onlyletters", acceptTerms: true });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.details[0].path).toBe("body/password");

    const noConsent = await post("/signup", { verificationToken, name: "Ravi", password: "monsoon77", acceptTerms: false });
    expect(noConsent.statusCode).toBe(400);

    const extra = await post("/signup", { verificationToken, name: "Ravi", password: "monsoon77", acceptTerms: true, admin: true });
    expect(extra.json().error.details[0].message).toBe('Unknown field "admin"');

    const stillWorks = await post("/signup", { verificationToken, name: "Ravi", password: "monsoon77", acceptTerms: true });
    expect(stillWorks.statusCode).toBe(201);
  });

  it("rejects numbers that are not Indian mobiles", async () => {
    const res = await post("/otp", { phone: "5123456789", purpose: "signup" });
    expect(res.statusCode).toBe(400);
  });
});

describe("codes", () => {
  it("counts wrong codes and locks after five", async () => {
    const phone = newPhone();
    await post("/otp", { phone, purpose: "signup" });
    const real = stack.texts.get(`+91${phone}`)!;
    const wrong = real === "000000" ? "111111" : "000000";

    const first = await post("/otp/verify", { phone, purpose: "signup", code: wrong });
    expect(first.statusCode).toBe(422);
    expect(first.json().error).toMatchObject({ code: "OTP_INVALID", details: [{ attemptsLeft: 4 }] });

    for (let i = 0; i < 3; i++) await post("/otp/verify", { phone, purpose: "signup", code: wrong });
    const fifth = await post("/otp/verify", { phone, purpose: "signup", code: wrong });
    expect(fifth.json().error.code).toBe("OTP_LIMIT");

    const right = await post("/otp/verify", { phone, purpose: "signup", code: real });
    expect(right.json().error.code).toBe("OTP_LIMIT");
  });

  it("waits 30 seconds between texts and allows three resends", async () => {
    const phone = newPhone();
    const target = `+91${phone}`;
    expect((await post("/otp", { phone, purpose: "signup" })).statusCode).toBe(200);
    const tooSoon = await post("/otp", { phone, purpose: "signup" });
    expect(tooSoon.json().error.code).toBe("OTP_LIMIT");
    expect(tooSoon.json().error.details[0].retryAfterSeconds).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      await stack.db.otps.updateOne({ target }, { $set: { lastSentAt: new Date(Date.now() - 31_000) } });
      expect((await post("/otp", { phone, purpose: "signup" })).statusCode).toBe(200);
    }
    await stack.db.otps.updateOne({ target }, { $set: { lastSentAt: new Date(Date.now() - 31_000) } });
    expect((await post("/otp", { phone, purpose: "signup" })).json().error.code).toBe("OTP_LIMIT");
  });

  it("only accepts the newest code", async () => {
    const phone = newPhone();
    const target = `+91${phone}`;
    await post("/otp", { phone, purpose: "signup" });
    const old = stack.texts.get(target)!;
    await stack.db.otps.updateOne({ target }, { $set: { lastSentAt: new Date(Date.now() - 31_000) } });
    await post("/otp", { phone, purpose: "signup" });
    const fresh = stack.texts.get(target)!;
    if (old !== fresh) {
      expect((await post("/otp/verify", { phone, purpose: "signup", code: old })).json().error.code).toBe("OTP_INVALID");
    }
    expect((await post("/otp/verify", { phone, purpose: "signup", code: fresh })).statusCode).toBe(200);
  });

  it("sends one text when two requests arrive together", async () => {
    const phone = newPhone();
    const before = stack.sms.sent;
    const replies = await Promise.all([0, 1, 2].map(() => post("/otp", { phone, purpose: "signup" })));
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 429, 429]);
    expect(stack.sms.sent - before).toBe(1);
    expect(replies.find((r) => r.statusCode === 429)!.headers["retry-after"]).toBeTruthy();
  });

  it("lets you ask again straight away when the text could not be sent", async () => {
    const phone = newPhone();
    stack.sms.failNext = true;
    expect((await post("/otp", { phone, purpose: "signup" })).statusCode).toBe(503);
    expect((await post("/otp", { phone, purpose: "signup" })).statusCode).toBe(200);
  });

  it("counts every text sent per India day, and not the ones that failed", async () => {
    const day = new Date(Date.now() + 5.5 * 60 * 60_000).toISOString().slice(0, 10);
    const today = async () => (await stack.db.counters.findOne({ _id: `sms-${day}` }))?.seq ?? 0;
    const before = await today();
    await post("/otp", { phone: newPhone(), purpose: "signup" });
    stack.sms.failNext = true;
    await post("/otp", { phone: newPhone(), purpose: "signup" });
    expect(await today()).toBe(before + 1);
  });

  it("says when there is no code to check", async () => {
    const res = await post("/otp/verify", { phone: newPhone(), purpose: "signup", code: "123456" });
    expect(res.json().error.code).toBe("OTP_EXPIRED");
  });
});

describe("login", () => {
  it("signs in with number and password, and treats unknown numbers like wrong passwords", async () => {
    const { phone, password } = await signUp();
    const ok = await post("/login", { phone, password }, APP);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.tokens.refreshToken).toBeTruthy();

    const wrong = await post("/login", { phone, password: "nottheone1" });
    const unknown = await post("/login", { phone: newPhone(), password });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error).toEqual(wrong.json().error);
  });

  it("locks after five wrong passwords, even for the right one", async () => {
    const { phone, password } = await signUp();
    for (let i = 0; i < 4; i++) expect((await post("/login", { phone, password: "nottheone1" })).statusCode).toBe(401);
    const fifth = await post("/login", { phone, password: "nottheone1" });
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error.code).toBe("ACCOUNT_LOCKED");
    expect((await post("/login", { phone, password })).statusCode).toBe(423);
  });

  it("checks at most five passwords from a burst of parallel guesses", async () => {
    const { phone, password } = await signUp();
    const replies = await Promise.all(Array.from({ length: 12 }, () => post("/login", { phone, password: "nottheone1" })));
    const codes = replies.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(4);
    expect(codes.filter((c) => c === 423).length).toBeGreaterThanOrEqual(8);
    expect((await post("/login", { phone, password })).statusCode).toBe(423);
  });

  it("forgets earlier wrong passwords after a good sign-in", async () => {
    const { phone, password } = await signUp();
    for (let i = 0; i < 4; i++) await post("/login", { phone, password: "nottheone1" });
    expect((await post("/login", { phone, password })).statusCode).toBe(200);
    expect((await stack.db.users.findOne({ phone: `+91${phone}` }))?.lock).toEqual({ failedCount: 0, lockedUntil: null });
  });
});

describe("sign in with a code", () => {
  const codeFor = async (phone: string) => {
    const sent = await post("/otp", { phone, purpose: "login" }, APP);
    expect(sent.statusCode).toBe(200);
    return stack.texts.get(`+91${phone}`)!;
  };

  it("signs in with the texted code and gives the app tokens", async () => {
    const { phone } = await signUp();
    const code = await codeFor(phone);
    const res = await post("/login/code", { phone, code, deviceName: "Pixel 8" }, APP);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.phone).toBe(`+91${phone}`);
    expect(res.json().data.tokens.refreshToken).toBeTruthy();
    expect((await post("/login/code", { phone, code }, APP)).statusCode).toBe(422);
  });

  it("only texts numbers that have an account", async () => {
    const res = await post("/otp", { phone: newPhone(), purpose: "login" }, APP);
    expect(res.statusCode).toBe(404);
  });

  it("does not accept a signup code for signing in", async () => {
    const { phone } = await signUp();
    await stack.db.otps.deleteMany({ target: `+91${phone}` });
    await post("/otp", { phone, purpose: "reset" }, APP);
    const resetCode = stack.texts.get(`+91${phone}`)!;
    const res = await post("/login/code", { phone, code: resetCode }, APP);
    expect(res.json().error.code).toBe("OTP_EXPIRED");
  });
});

describe("full signup", () => {
  it("saves the chosen username, date of birth, gender and email", async () => {
    const phone = newPhone();
    const verificationToken = await verified(phone, "signup", APP);
    const handle = `meera.${String(seq).padStart(2, "0")}x`;
    const res = await post(
      "/signup",
      { verificationToken, name: "Meera Iyer", password: "sunrise42", acceptTerms: true, username: handle, dob: "2001-04-12", gender: "female", email: `Meera.${phone}@Example.com` },
      APP,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().data.user).toMatchObject({ username: handle, dob: "2001-04-12", gender: "female", email: `meera.${phone}@example.com` });
  });

  it("refuses a taken username, a bad email and an under-13 date of birth, but not someone else's unverified email", async () => {
    const { res } = await signUp();
    const taken = res.json().data.user.username as string;
    const attempt = async (extra: object) => {
      const verificationToken = await verified(newPhone(), "signup");
      return post("/signup", { verificationToken, name: "Ravi Kumar", password: "monsoon77", acceptTerms: true, ...extra });
    };
    expect((await attempt({ username: taken })).json().error.code).toBe("USERNAME_TAKEN");
    expect((await attempt({ username: "admin" })).json().error.code).toBe("USERNAME_TAKEN");
    expect((await attempt({ email: "not-an-email" })).statusCode).toBe(400);
    const young = new Date();
    young.setFullYear(young.getFullYear() - 10);
    expect((await attempt({ dob: young.toISOString().slice(0, 10) })).json().error.details[0].path).toBe("body/dob");

    const email = `ravi.${Date.now()}@example.com`;
    expect((await attempt({ email })).statusCode).toBe(201);
    const second = await attempt({ email: email.toUpperCase() });
    expect(second.statusCode).toBe(201);
    expect(second.json().data.user).toMatchObject({ email, emailVerified: false });
  });

  it("verifies an email with a code, and lets only one account verify an address", async () => {
    const email = `share.${Date.now()}@example.com`;
    const accounts = await Promise.all([signUp(), signUp()]);
    const [first, second] = accounts.map(({ res }) => ({ rx_at: cookieMap(res).rx_at! }));
    const call = (cookies: Record<string, string>, url: string, payload?: object) =>
      stack.app.inject({ method: payload ? "PATCH" : "POST", url: `/v1/account${url}`, headers: WEB, cookies, ...(payload ? { payload } : {}) });
    const verifyWith = (cookies: Record<string, string>, code: string) =>
      stack.app.inject({ method: "POST", url: "/v1/account/email/verify", headers: WEB, cookies, payload: { code } });

    expect((await call(first!, "/email/code")).json().error.details[0].path).toBe("body/email");
    await call(first!, "/me", { email });
    await call(second!, "/me", { email });

    const sent = await call(first!, "/email/code");
    expect(sent.json().data.sentTo).toBe("sh***@example.com");
    const wrong = await verifyWith(first!, stack.emails.get(email) === "000000" ? "111111" : "000000");
    expect(wrong.json().error).toMatchObject({ code: "OTP_INVALID", details: [{ attemptsLeft: 4 }] });
    const ok = await verifyWith(first!, stack.emails.get(email)!);
    expect(ok.json().data).toMatchObject({ email, emailVerified: true });
    expect((await call(first!, "/email/code")).json().error.code).toBe("CONFLICT");

    await call(second!, "/email/code");
    expect((await verifyWith(second!, stack.emails.get(email)!)).json().error.code).toBe("EMAIL_TAKEN");

    const changed = await call(first!, "/me", { email: `new.${email}` });
    expect(changed.json().data).toMatchObject({ email: `new.${email}`, emailVerified: false });
  });

  it("adds and removes an email on the profile", async () => {
    const { res } = await signUp();
    const cookies = { rx_at: cookieMap(res).rx_at! };
    const patch = (payload: object) => stack.app.inject({ method: "PATCH", url: "/v1/account/me", headers: WEB, cookies, payload });
    expect((await patch({ email: `asha.${Date.now()}@example.com` })).json().data.email).toMatch(/@example\.com$/);
    expect((await patch({ email: null })).json().data.email).toBeNull();
    const updated = (await patch({ bio: "Prints zines." })).json().data;
    expect(updated.bio).toBe("Prints zines.");
    expect(updated).not.toHaveProperty("link");
    expect((await patch({ link: "https://asha.example.com" })).statusCode).toBe(400);
    const spaced = (await patch({ bio: "Prints zines.  \r\n\n\n\n\nMakes posters.\n\n" })).json().data;
    expect(spaced.bio).toBe("Prints zines.\n\nMakes posters.");
    const long = (await patch({ bio: "One\nTwo\n\nThree\n\nFour" })).json().data;
    expect(long.bio).toBe("One\nTwo\n\nThree Four");
  });
});

describe("refresh", () => {
  it("rotates the refresh token and ends the session when an old one comes back", async () => {
    const { res } = await signUp(newPhone(), "sunrise42", APP);
    const first = res.json().data.tokens.refreshToken as string;

    const rotated = await post("/refresh", { refreshToken: first }, APP);
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json().data.tokens.refreshToken as string;
    expect(second).not.toBe(first);

    const replay = await post("/refresh", { refreshToken: first }, APP);
    expect(replay.statusCode).toBe(401);
    const afterTheft = await post("/refresh", { refreshToken: second }, APP);
    expect(afterTheft.statusCode).toBe(401);
  });

  it("lets a second browser tab refresh at the same moment without signing out", async () => {
    const { res } = await signUp();
    const rt = cookieMap(res).rx_rt!;
    const one = await post("/refresh", {}, WEB, { rx_rt: rt });
    expect(one.statusCode).toBe(200);
    expect(cookieMap(one).rx_rt).toBeTruthy();

    const two = await post("/refresh", {}, WEB, { rx_rt: rt });
    expect(two.statusCode).toBe(200);
    expect(cookieMap(two).rx_at).toBeTruthy();
    expect(cookieMap(two).rx_rt).toBeUndefined();

    const three = await post("/refresh", {}, WEB, { rx_rt: cookieMap(one).rx_rt! });
    expect(three.statusCode).toBe(200);
  });
});

describe("password reset", () => {
  it("refuses unknown numbers and recent passwords, then signs out every device", async () => {
    const unknown = await post("/otp", { phone: newPhone(), purpose: "reset" });
    expect(unknown.statusCode).toBe(404);

    const { phone, password, res } = await signUp(newPhone(), "sunrise42", APP);
    const oldRefresh = res.json().data.tokens.refreshToken as string;

    const sameToken = await verified(phone, "reset");
    const reused = await post("/password/reset", { verificationToken: sameToken, password });
    expect(reused.json().error.code).toBe("PASSWORD_REUSED");

    const token = await verified(phone, "reset");
    expect((await post("/password/reset", { verificationToken: token, password: "harvest2026" })).statusCode).toBe(200);
    expect((await post("/refresh", { refreshToken: oldRefresh }, APP)).statusCode).toBe(401);
    expect((await post("/login", { phone, password })).statusCode).toBe(401);
    expect((await post("/login", { phone, password: "harvest2026" })).statusCode).toBe(200);

    const audit = await stack.db.auditLogs.findOne({ action: "user.password_reset" });
    expect(audit).toBeTruthy();
  });
});

describe("per-IP limits", () => {
  it("answers 429 with a retry time once one address sends too many login attempts", async () => {
    const limited = await startStack(undefined, { rateLimit: true });
    try {
      let last;
      for (let i = 0; i < 61; i++) {
        last = await limited.app.inject({
          method: "POST",
          url: "/v1/account/login",
          headers: WEB,
          payload: { phone: "9876500000", password: "whatever1" },
        });
      }
      expect(last!.statusCode).toBe(429);
      expect(last!.json().error.code).toBe("RATE_LIMITED");
      expect(last!.json().error.details[0].retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      await limited.stop();
    }
  }, 60_000);
});

describe("profile and sessions", () => {
  it("updates the profile and refuses a taken username or a child's birth date", async () => {
    const a = await signUp();
    const b = await signUp();
    const at = cookieMap(b.res).rx_at!;
    const patch = (payload: object) =>
      stack.app.inject({ method: "PATCH", url: "/v1/account/me", headers: WEB, cookies: { rx_at: at }, payload });

    const updated = await patch({ username: "rao.asha", city: "Hyderabad", gender: "female", dob: "1998-04-12" });
    expect(updated.json().data).toMatchObject({ username: "rao.asha", city: "Hyderabad", gender: "female", dob: "1998-04-12" });

    const aAt = cookieMap(a.res).rx_at!;
    const taken = await stack.app.inject({
      method: "PATCH",
      url: "/v1/account/me",
      headers: WEB,
      cookies: { rx_at: aAt },
      payload: { username: "rao.asha" },
    });
    expect(taken.json().error.code).toBe("USERNAME_TAKEN");

    const child = await patch({ dob: `${new Date().getFullYear() - 5}-01-01` });
    expect(child.statusCode).toBe(400);
  });

  it("lists devices, signs one out, and logs out the current one", async () => {
    const { phone, password, res } = await signUp();
    const webAt = cookieMap(res).rx_at!;
    const phoneLogin = await post("/login", { phone, password, deviceName: "Pixel 8" }, APP);
    const appAt = phoneLogin.json().data.tokens.accessToken as string;

    const list = await stack.app.inject({ method: "GET", url: "/v1/account/sessions", headers: WEB, cookies: { rx_at: webAt } });
    const sessions = list.json().data as { id: string; label: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    const pixel = sessions.find((s) => s.label === "Pixel 8")!;
    expect(pixel.current).toBe(false);

    const revoke = await stack.app.inject({
      method: "DELETE",
      url: `/v1/account/sessions/${pixel.id}`,
      headers: WEB,
      cookies: { rx_at: webAt },
    });
    expect(revoke.statusCode).toBe(200);
    const appMe = await stack.app.inject({ method: "GET", url: "/v1/account/me", headers: { ...APP, authorization: `Bearer ${appAt}` } });
    expect(appMe.statusCode).toBe(401);

    const out = await post("/logout", {}, WEB, { rx_at: webAt });
    expect(out.statusCode).toBe(200);
    expect(out.cookies.find((c) => c.name === "rx_at")?.value).toBe("");
    const after = await stack.app.inject({ method: "GET", url: "/v1/account/me", headers: WEB, cookies: { rx_at: webAt } });
    expect(after.statusCode).toBe(401);
  });

  it("deletes the account after the password: signs out everywhere, stops sign-in and frees the number and username", async () => {
    const { phone, password, res } = await signUp();
    const webAt = cookieMap(res).rx_at!;
    const username = res.json().data.user.username as string;
    const appAt = (await post("/login", { phone, password }, APP)).json().data.tokens.accessToken as string;
    const remove = (payload?: object) =>
      stack.app.inject({ method: "DELETE", url: "/v1/account/me", headers: WEB, cookies: { rx_at: webAt }, ...(payload ? { payload } : {}) });

    expect((await remove()).statusCode).toBe(400);
    const wrong = await remove({ password: "not-it-99" });
    expect(wrong.json().error).toMatchObject({ code: "INVALID_CREDENTIALS", details: [{ path: "body/password" }] });
    expect((await stack.app.inject({ method: "GET", url: "/v1/account/me", headers: WEB, cookies: { rx_at: webAt } })).statusCode).toBe(200);

    const del = await remove({ password });
    expect(del.statusCode).toBe(200);
    expect(del.cookies.find((c) => c.name === "rx_at")?.value).toBe("");

    const appMe = await stack.app.inject({ method: "GET", url: "/v1/account/me", headers: { ...APP, authorization: `Bearer ${appAt}` } });
    expect(appMe.statusCode).toBe(401);
    expect((await post("/login", { phone, password }, APP)).json().error.code).toBe("INVALID_CREDENTIALS");
    expect((await post("/otp", { phone, purpose: "login" }, APP)).statusCode).toBe(404);

    const stored = await stack.db.users.findOne({ "deletion.phone": `+91${phone}` });
    expect(stored).toMatchObject({ status: "deleted", deletion: { username } });
    expect(stored?.username).toBeUndefined();
    expect(stored?.purgeAt?.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);

    await signUp(phone);
  });

  it("moves a push token to the newest session that registers it", async () => {
    const { phone, password } = await signUp(newPhone(), "sunrise42", APP);
    const one = (await post("/login", { phone, password }, APP)).json().data.tokens.accessToken as string;
    const two = (await post("/login", { phone, password }, APP)).json().data.tokens.accessToken as string;
    const register = (token: string) =>
      stack.app.inject({
        method: "POST",
        url: "/v1/account/devices",
        headers: { ...APP, authorization: `Bearer ${token}` },
        payload: { pushToken: "fcm-token-1" },
      });
    expect((await register(one)).statusCode).toBe(200);
    expect((await register(two)).statusCode).toBe(200);
    expect(await stack.db.sessions.countDocuments({ pushToken: "fcm-token-1" })).toBe(1);
  });
});

describe("names, usernames and city", () => {
  const as = (at: string) => ({ headers: WEB, cookies: { rx_at: at } });

  it("refuses a phone number as a name, at signup and later", async () => {
    const phone = newPhone();
    const verificationToken = await verified(phone, "signup");
    const res = await post("/signup", { verificationToken, name: phone, password: "sunrise42", acceptTerms: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0]).toMatchObject({ path: "body/name" });

    const { res: ok } = await signUp();
    const patch = await stack.app.inject({ method: "PATCH", url: "/v1/account/me", ...as(cookieMap(ok).rx_at!), payload: { name: "7777912365" } });
    expect(patch.statusCode).toBe(400);
  });

  it("suggests free handles from the name and checks the typed one", async () => {
    const { res } = await signUp();
    const me = res.json().data.user as { username: string };
    const at = cookieMap(res).rx_at!;
    const check = (handle?: string) =>
      stack.app.inject({ method: "GET", url: `/v1/account/usernames${handle ? `?check=${handle}` : ""}`, ...as(at) });

    const plain = (await check()).json().data as { available: null; suggestions: string[] };
    expect(plain.available).toBeNull();
    expect(plain.suggestions.length).toBeGreaterThan(0);
    expect(plain.suggestions).not.toContain(me.username);
    for (const s of plain.suggestions) expect(s).toMatch(/^[a-z0-9_.]{3,20}$/);

    expect((await check(me.username)).json().data.available).toBe(true);
    expect((await check("ruxstar")).json().data.available).toBe(false);
    expect((await check("no%20spaces")).json().data.available).toBe(false);

    const reserved = await stack.app.inject({ method: "PATCH", url: "/v1/account/me", ...as(at), payload: { username: "ruxstar" } });
    expect(reserved.json().error.code).toBe("USERNAME_TAKEN");
  });

  it("looks up the city for a point", async () => {
    const { res } = await signUp();
    const at = cookieMap(res).rx_at!;
    const found = await stack.app.inject({ method: "GET", url: "/v1/account/city?lat=17.385&lng=78.4867", ...as(at) });
    expect(found.json().data).toMatchObject({ city: "Hyderabad" });
    const bad = await stack.app.inject({ method: "GET", url: "/v1/account/city?lat=200&lng=78", ...as(at) });
    expect(bad.statusCode).toBe(400);
  });

  it("checks usernames before signup, from the name being typed", async () => {
    const res = await stack.app.inject({ method: "GET", url: "/v1/account/usernames?name=Meera%20Iyer&check=ruxstar", headers: APP });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.available).toBe(false);
    expect(res.json().data.suggestions[0]).toMatch(/meera|iyer/);
  });

  it("answers 503 while the database is still connecting", async () => {
    stack.db.ready = false;
    try {
      const res = await post("/otp", { phone: newPhone(), purpose: "signup" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("NOT_READY");
      expect(res.headers["retry-after"]).toBe("5");
    } finally {
      stack.db.ready = true;
    }
  });
});

describe("profile photos and public profiles", () => {
  const image = (width: number, height: number, format: "jpeg" | "png" = "jpeg") =>
    sharp({ create: { width, height, channels: 3, background: "#b45cf2" } })
      .withExif({ IFD0: { Make: "TestCam", Model: "Leaky 1" } })
      [format]()
      .toBuffer();
  const upload = (at: string, payload: Buffer | string, type = "image/jpeg") =>
    stack.app.inject({ method: "PUT", url: "/v1/account/me/photo", headers: { ...WEB, "content-type": type }, cookies: { rx_at: at }, payload });

  it("saves a square WebP without metadata, replaces the old one and removes it", async () => {
    const { res } = await signUp();
    const at = cookieMap(res).rx_at!;
    const userId = res.json().data.user.id as string;
    expect(res.json().data.user.avatarUrl).toBeNull();

    const first = await upload(at, await image(1200, 800));
    expect(first.statusCode).toBe(200);
    const firstUrl = first.json().data.avatarUrl as string;
    expect(firstUrl).toMatch(new RegExp(`^https://photos\\.test/profile-pictures/dev/${userId}/[\\w-]+\\.webp$`));
    const firstKey = firstUrl.replace("https://photos.test/", "");
    const meta = await sharp(stack.photos.get(firstKey)!).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();

    const second = await upload(at, await image(300, 300, "png"), "image/png");
    const secondUrl = second.json().data.avatarUrl as string;
    expect(secondUrl).not.toBe(firstUrl);
    expect(stack.photos.has(firstKey)).toBe(false);

    const me = await stack.app.inject({ method: "GET", url: "/v1/account/me", headers: WEB, cookies: { rx_at: at } });
    expect(me.json().data.avatarUrl).toBe(secondUrl);

    const removed = await stack.app.inject({ method: "DELETE", url: "/v1/account/me/photo", headers: WEB, cookies: { rx_at: at } });
    expect(removed.json().data.avatarUrl).toBeNull();
    expect(stack.photos.has(secondUrl.replace("https://photos.test/", ""))).toBe(false);
  });

  it("refuses files that are not photos, tiny images, oversized uploads and signed-out callers", async () => {
    const { res } = await signUp();
    const at = cookieMap(res).rx_at!;
    expect((await upload(at, "not really a jpeg")).json().error.code).toBe("PHOTO_INVALID");
    expect((await upload(at, await image(40, 40))).json().error.code).toBe("PHOTO_INVALID");
    expect((await upload(at, "{}", "application/json")).json().error.code).toBe("PHOTO_INVALID");
    expect((await upload(at, Buffer.alloc(5 * 1024 * 1024 + 1))).statusCode).toBe(413);
    const anon = await stack.app.inject({
      method: "PUT",
      url: "/v1/account/me/photo",
      headers: { ...WEB, "content-type": "image/jpeg" },
      payload: await image(200, 200),
    });
    expect(anon.statusCode).toBe(401);
  });

  it("shows the public profile by username or id, and never the private fields", async () => {
    const { res } = await signUp();
    const at = cookieMap(res).rx_at!;
    const user = res.json().data.user as { id: string; username: string };
    await stack.app.inject({
      method: "PATCH",
      url: "/v1/account/me",
      headers: WEB,
      cookies: { rx_at: at },
      payload: { bio: "Bakes on weekends", city: "Pune", dob: "1995-01-01", gender: "female", email: "asha@example.com" },
    });
    await upload(at, await image(600, 600));

    const byName = await stack.app.inject({ method: "GET", url: `/v1/account/profiles/${user.username.toUpperCase()}`, headers: WEB });
    expect(byName.statusCode).toBe(200);
    expect(byName.headers["cache-control"]).toBe("public, max-age=60");
    const profile = byName.json().data;
    expect(Object.keys(profile).sort()).toEqual(["avatarUrl", "badges", "bio", "city", "id", "memberSince", "name", "stats", "username"]);
    expect(profile.stats).toEqual({ posts: 0, engagements: 0, followers: 0, following: 0 });
    expect(profile).toMatchObject({ id: user.id, name: "Asha Rao", bio: "Bakes on weekends", city: "Pune", badges: { vendor: false, delivery: false } });
    expect(profile.avatarUrl).toMatch(/\.webp$/);

    const byId = await stack.app.inject({ method: "GET", url: `/v1/account/profiles/${user.id}`, headers: APP });
    expect(byId.json().data.username).toBe(user.username);

    const missing = await stack.app.inject({ method: "GET", url: "/v1/account/profiles/no.such.person", headers: WEB });
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });

  it("finds people by the start of a username or of a word in their name, never yourself", async () => {
    const searcher = cookieMap((await signUp()).res).rx_at!;
    const { res } = await signUp();
    const found = cookieMap(res).rx_at!;
    const handle = `kt${Date.now().toString(36)}`;
    await stack.app.inject({
      method: "PATCH",
      url: "/v1/account/me",
      headers: WEB,
      cookies: { rx_at: found },
      payload: { name: "Kavya Thakkar", username: handle },
    });
    const search = (q: string, at?: string) =>
      stack.app.inject({ method: "GET", url: `/v1/account/profiles?q=${encodeURIComponent(q)}`, headers: APP, ...(at ? { cookies: { rx_at: at } } : {}) });
    const usernames = async (q: string, at = searcher) => ((await search(q, at)).json().data as { username: string }[]).map((p) => p.username);

    const exact = (await search(handle, searcher)).json().data;
    expect(exact[0].username).toBe(handle);
    expect(Object.keys(exact[0]).sort()).toEqual(["avatarUrl", "badges", "bio", "city", "id", "memberSince", "name", "stats", "username"]);
    const newest = (await stack.app.inject({ method: "GET", url: "/v1/account/profiles", headers: APP, cookies: { rx_at: searcher } })).json().data;
    expect(newest[0].username).toBe(handle);
    expect(newest.length).toBeLessThanOrEqual(20);
    expect(await usernames(`@${handle.slice(0, 6).toUpperCase()}`)).toContain(handle);
    expect(await usernames("thakk")).toContain(handle);
    expect(await usernames("hakkar")).not.toContain(handle);
    expect(await usernames(handle, found)).not.toContain(handle);
    expect((await search("k", searcher)).statusCode).toBe(400);
    expect((await search(handle)).statusCode).toBe(401);
  });

  it("hides a deleted account's profile and deletes its photo", async () => {
    const { password, res } = await signUp();
    const at = cookieMap(res).rx_at!;
    const user = res.json().data.user as { id: string; username: string };
    const key = ((await upload(at, await image(200, 200))).json().data.avatarUrl as string).replace("https://photos.test/", "");
    expect(stack.photos.has(key)).toBe(true);

    await stack.app.inject({ method: "DELETE", url: "/v1/account/me", headers: WEB, cookies: { rx_at: at }, payload: { password } });
    expect(stack.photos.has(key)).toBe(false);
    for (const ref of [user.username, user.id]) {
      const gone = await stack.app.inject({ method: "GET", url: `/v1/account/profiles/${ref}`, headers: WEB });
      expect(gone.statusCode).toBe(404);
    }
  });
});
