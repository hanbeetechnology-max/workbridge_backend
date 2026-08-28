import { ApiError } from "../utils/ApiError.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

// Render's network blocks outbound SMTP entirely — confirmed across three
// ports (465/587 time out at the network level; 2525 gets ECONNRESET,
// since Hostinger doesn't even listen there). Resend's HTTPS API sidesteps
// this completely; port 443 outbound is never blocked by any host.
function requireEmailConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.OTP_FROM_EMAIL;

  if (!apiKey || !from) return null;
  return { apiKey, from };
}

// The caller (auth.controller.js) decides what "not configured" means —
// console-log fallback in dev, hard failure in production.
export function isEmailConfigured() {
  return requireEmailConfig() !== null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Shared by sendOtpEmail/sendPasswordResetEmail — same transport, error
// handling, and Resend request shape; only subject/body content differs.
async function sendEmail({ to, subject, text, html }) {
  const config = requireEmailConfig();
  if (!config) throw ApiError.internal("OTP email delivery is not configured.");
  const { apiKey, from } = config;

  let response;
  try {
    response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "WorkBridge OTP/1.0",
      },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
  } catch (err) {
    console.error("[email] Resend request failed:", err);
    throw ApiError.internal("Could not send the verification email.");
  }

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("[email] Resend delivery failed:", result);
    throw ApiError.internal("Could not send the verification email.");
  }

  return result;
}

export async function sendOtpEmail({ to, otpCode, expiresInMinutes }) {
  const safeCode = escapeHtml(otpCode);
  return sendEmail({
    to,
    subject: "Your WorkBridge verification code",
    text: `Your WorkBridge verification code is ${otpCode}. It expires in ${expiresInMinutes} minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
        <p>Your WorkBridge verification code is:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:18px 0">${safeCode}</p>
        <p>This code expires in ${expiresInMinutes} minutes.</p>
        <p>If you did not request this code, you can ignore this email.</p>
      </div>
    `,
  });
}

// Real money sits frozen the moment a dispute is raised, and — unlike
// every other admin queue on this platform — nothing else alerts staff to
// it out-of-band; they'd otherwise only find out by happening to open the
// Admin Panel (see events.js's emitDisputeRaised, which sends this
// alongside a live socket push to any admin who does have it open right
// now). Best-effort, one send per admin — a failed delivery to one staff
// inbox must never block the others or the dispute-raise action itself.
export async function sendDisputeRaisedEmail({ to, projectTitle, raiserRole, reason, adminUrl }) {
  const safeTitle = escapeHtml(projectTitle);
  const safeReason = escapeHtml(reason);
  const raiser = raiserRole === "business" ? "The business" : "The worker";
  return sendEmail({
    to,
    subject: `Dispute raised — "${projectTitle}"`,
    text: `${raiser} raised a dispute on "${projectTitle}":\n\n"${reason}"\n\nFunds are frozen until this is resolved. Review it: ${adminUrl}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
        <p>${raiser} raised a dispute on <strong>${safeTitle}</strong>:</p>
        <p style="margin:18px 0;padding:14px 18px;background:#fef2f2;border-left:3px solid #dc2626;color:#991b1b">"${safeReason}"</p>
        <p>Funds are frozen until this is resolved.</p>
        <p><a href="${adminUrl}" style="color:#1B3FAB;font-weight:700">Review in the Admin Panel →</a></p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail({ to, otpCode, expiresInMinutes }) {
  const safeCode = escapeHtml(otpCode);
  return sendEmail({
    to,
    subject: "Your WorkBridge password reset code",
    text: `Your WorkBridge password reset code is ${otpCode}. It expires in ${expiresInMinutes} minutes. If you did not request this, you can ignore this email — your password will not change.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
        <p>Your WorkBridge password reset code is:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:18px 0">${safeCode}</p>
        <p>This code expires in ${expiresInMinutes} minutes.</p>
        <p>If you did not request this, you can ignore this email — your password will not change.</p>
      </div>
    `,
  });
}
