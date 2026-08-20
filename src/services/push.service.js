import webpush from "web-push";
import * as pushSubscriptionsRepo from "../repositories/push_subscriptions.repository.js";
import * as usersRepo from "../repositories/users.repository.js";

// Same "optional, silent no-op without config" convention as
// email.service.js's requireEmailConfig — push is a real feature once
// VAPID_* is set (see .env / Render env vars), but its absence (or, as
// happened once already, a malformed value — a trailing newline/space from
// pasting into Render's env var UI is enough to fail web-push's base64url
// check) should never break the request that triggered the notification, or
// worse, crash the whole process at boot the way an unguarded
// setVapidDetails() call did. .trim() defends against the common paste
// artifact; the try/catch below is the actual hard guarantee.
function requirePushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();

  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

function initVapid() {
  const pushConfig = requirePushConfig();
  if (!pushConfig) return null;

  try {
    webpush.setVapidDetails(pushConfig.subject, pushConfig.publicKey, pushConfig.privateKey);
    return pushConfig;
  } catch (err) {
    console.error("[push] Invalid VAPID_* env vars — push notifications disabled:", err.message);
    return null;
  }
}

const config = initVapid();

export function isPushConfigured() {
  return config !== null;
}

export function getVapidPublicKey() {
  return config?.publicKey ?? null;
}

// Fire-and-forget from the caller's perspective — every call site in
// events.js already just triggered a real socket event for the same
// notification; a push failure (unconfigured, a dead subscription, a
// transient network error) must never throw back into that code path.
// Sends to every device this user has subscribed on, and prunes any
// subscription the push service reports as gone (404/410 — uninstalled,
// permission revoked, or the browser expired it) so listForUser stops
// carrying dead weight.
// `category` ("chat" | "projects" | "payments") is optional — omitted for
// notifications with no matching Settings toggle (e.g. support replies),
// which always send. When present, it's checked against the user's
// notification_prefs (Settings > Notifications) before anything is sent —
// a category a user has turned off should never buzz their device just
// because push itself is still subscribed.
export async function sendPushToUser(userId, { title, body, url }, category) {
  if (!config) return;

  if (category) {
    const user = await usersRepo.findById(userId);
    if (user && user.notification_prefs?.[category] === false) return;
  }

  const subscriptions = await pushSubscriptionsRepo.listForUser(userId);
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({ title, body, url: url ?? "/" });
  const staleEndpoints = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          staleEndpoints.push(sub.endpoint);
        } else {
          console.error(`[push] Delivery to ${sub.endpoint} failed:`, err.statusCode, err.body);
        }
      }
    })
  );

  if (staleEndpoints.length > 0) {
    await pushSubscriptionsRepo.deleteByEndpoints(staleEndpoints);
  }
}
