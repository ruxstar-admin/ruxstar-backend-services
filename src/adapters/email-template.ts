const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The email-verification code message. Tables and inline styles because Gmail and Outlook drop
 * most CSS; no images, so it reads the same when a mail app blocks them.
 */
export function codeEmail(to: string, code: string, minutes: number) {
  const subject = `${code} is your Ruxstar code`;
  const text = [
    "Verify your email",
    "",
    `Your Ruxstar code is ${code}`,
    `It expires in ${minutes} minutes.`,
    "",
    "Enter it in Ruxstar to confirm this email address is yours. Ruxstar will never ask you to share this code.",
    "",
    "Did not ask for this? You can ignore this email. Someone may have typed your address by mistake.",
    "",
    `Sent by Ruxstar to ${to}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${subject}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .rx-bg { background: #09080E !important; }
    .rx-card { background: #15141A !important; }
    .rx-ink { color: #FFFFFF !important; }
    .rx-ink-2 { color: #B6B4C1 !important; }
    .rx-code { background: #0D0C12 !important; color: #FFFFFF !important; }
    .rx-line { border-color: #302F37 !important; }
  }
</style>
</head>
<body class="rx-bg" style="margin:0;padding:0;background:#F4F4F5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your code is ${code}. It expires in ${minutes} minutes.&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rx-bg" style="background:#F4F4F5;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
        <tr>
          <td style="padding:0 8px 20px;font-family:${FONT};">
            <span class="rx-ink" style="font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.02em;color:#0A0A0A;">ruxstar</span><span style="display:inline-block;width:8px;height:8px;margin-left:3px;border-radius:50%;background:#EADC05;"></span>
          </td>
        </tr>
        <tr>
          <td class="rx-card" style="background:#FFFFFF;border-radius:18px;padding:36px 32px;font-family:${FONT};">
            <h1 class="rx-ink" style="margin:0 0 8px;font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.01em;color:#0A0A0A;">Verify your email</h1>
            <p class="rx-ink-2" style="margin:0 0 28px;font-size:16px;line-height:24px;color:#6B6B70;">Enter this code in Ruxstar to confirm this email address is yours.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" class="rx-code" style="background:#F4F4F5;border-radius:12px;padding:22px 12px;font-family:${FONT};font-size:38px;line-height:44px;font-weight:700;letter-spacing:10px;color:#0A0A0A;font-variant-numeric:tabular-nums;">${code}</td>
              </tr>
            </table>
            <p class="rx-ink-2" style="margin:14px 0 0;font-size:14px;line-height:20px;color:#6B6B70;text-align:center;">This code expires in ${minutes} minutes.</p>
            <hr class="rx-line" style="margin:28px 0 20px;border:0;border-top:1px solid #EAEAEC;">
            <p class="rx-ink-2" style="margin:0 0 8px;font-size:14px;line-height:20px;color:#6B6B70;"><strong class="rx-ink" style="color:#0A0A0A;">Did not ask for this?</strong> You can ignore this email. Someone may have typed your address by mistake.</p>
            <p class="rx-ink-2" style="margin:0;font-size:14px;line-height:20px;color:#6B6B70;">Ruxstar will never ask you to share this code.</p>
          </td>
        </tr>
        <tr>
          <td align="center" class="rx-ink-2" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#76767C;">Sent by Ruxstar to ${escapeHtml(to)}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}
