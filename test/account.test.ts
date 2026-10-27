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

async function verified(phone: string, purpose: "signup" | "reset", headers = WEB) {
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
    expect(sent.json().data).toEqual({ sentTo: `+91 ••••• •${phone.slice(-4)}`, expiresInSeconds: 300, resendInSeconds: 30 });
    expect(stack.texts.get(`+91${phone}`)).toMatch(/^\d{6}$/);
    expect((await stack.db.otps.findOne({ target: `+91${phone}` }))?.codeHash).not.toContain(stack.texts.get(`+91${phone}`));
  });

  it("returns the user, sets httpOnly cookies and keeps tokens out of the body", async () => {
    const { phone, res } = await signUp();
    const body = res.json();
    expect(body.data.user).toMatchObject({ phone: `+91${phone}`, name: "Asha Rao", kyc: { base: "none" } });
    expect(body.data.user.username).toMatch(/^asharao\d{4}$/);
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

    const updated = await patch({ username: "asha.r", city: "Hyderabad", gender: "female", dob: "1998-04-12" });
    expect(updated.json().data).toMatchObject({ username: "asha.r", city: "Hyderabad", gender: "female", dob: "1998-04-12" });

    const aAt = cookieMap(a.res).rx_at!;
    const taken = await stack.app.inject({
      method: "PATCH",
      url: "/v1/account/me",
      headers: WEB,
      cookies: { rx_at: aAt },
      payload: { username: "asha.r" },
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
