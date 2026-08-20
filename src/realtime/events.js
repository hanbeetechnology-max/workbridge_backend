import { getIO, userRoom, projectRoom, adminRoom } from "./socket.js";
import { sendPushToUser } from "../services/push.service.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as notificationsRepo from "../repositories/notifications.repository.js";

// Real device push (Notification/Push API — see push.service.js) reaches a
// user whether or not they're actively connected via socket right now,
// which is the whole point of it — so every push send below happens
// unconditionally, never gated behind `if (!io) return` the way the socket
// emits are. It's always fire-and-forget from the caller's perspective: a
// chat message send, a status change, etc. must succeed regardless of
// whether push is configured or a delivery fails (see sendPushToUser's own
// try/catch per subscription).
// `category` maps to Settings > Notifications' toggles ("chat" | "projects"
// | "payments") and is checked by sendPushToUser against the recipient's
// notification_prefs; omitted for events with no matching toggle (broadcasts,
// support replies), which always send.
function firePush(userId, copy, category) {
  if (!copy) return;
  sendPushToUser(userId, copy, category).catch((err) => console.error("[push] sendPushToUser threw:", err));
}

// notifType ("PROJECT" | "PAYMENT" | "SYSTEM") is the notifications-table
// taxonomy (unrelated to and pre-dating the Settings toggles below) — this
// maps it to the closest toggle category rather than introducing a second,
// parallel type system. SYSTEM has no toggle (support replies etc. always
// send), so it maps to undefined.
function pushCategoryFor(notifType) {
  if (notifType === "PAYMENT") return "payments";
  if (notifType === "PROJECT") return "projects";
  return undefined;
}

// Persists the exact same copy a push notification used into the
// notifications table (migrations/030_notifications.sql) — every call site
// below already fires firePush with this `copy`, this just also gives the
// user an in-app history to look back at, not just a device notification
// that's gone once dismissed. Same fire-and-forget shape as firePush: a
// failed insert here must never break the socket emit or push send it runs
// alongside.
function fireNotification(userId, copy, type) {
  if (!copy) return;
  notificationsRepo
    .create({ userId, title: copy.title, message: copy.body, type, url: copy.url })
    .catch((err) => console.error("[notifications] create threw:", err));
}

// Real effect of the "Enterprise Broadcast" perk (projects.controller.js's
// broadcastProject) — the same real push + in-app notification primitives
// every other event on this platform uses, just fanned out to a list of
// worker ids instead of one participant. Each send is still independently
// fire-and-forget (see firePush/fireNotification's own comments) so one
// failed delivery in the batch never blocks the rest.
export function emitBroadcast(userIds, copy) {
  for (const userId of userIds) {
    firePush(userId, copy);
    fireNotification(userId, copy, "SYSTEM");
  }
}

// Coarse bucket per event type, matching the three the notifications table
// documents — not meant to be exhaustive UI taxonomy, just enough to color
// or filter the drawer by later if that's ever wanted.
function notificationTypeFor(eventType) {
  if (eventType === "COMPLETED") return "PAYMENT";
  if (eventType === "SUPPORT_MESSAGE_CREATED") return "SYSTEM";
  return "PROJECT";
}

const WORKER_JOB_FEED_URL = "/worker";
const BUSINESS_DASHBOARD_URL = "/business";

function workerNegotiationUrl(projectId) {
  return projectId ? `/worker/negotiations?invite=${projectId}` : "/worker/negotiations";
}

// Every business notification used to resolve to the bare BUSINESS_DASHBOARD_URL
// regardless of event type — clicking one while already sitting on Overview
// (BusinessDashboard.jsx's default tab) did nothing, since navigate("/business")
// to the page you're already on doesn't change tab state. BusinessDashboard.jsx
// reads ?tab= on mount (same convention as EconomyHub.jsx/WorkerWallet.jsx) so
// this can route to the actual relevant tab instead.
function businessDashboardUrl(tab) {
  return tab ? `/business?tab=${tab}` : BUSINESS_DASHBOARD_URL;
}

const BUSINESS_TAB_BY_EVENT = {
  PROJECT_CREATED: "projects",
  MESSAGE_CREATED: "negotiations",
  STATUS_CHANGED: "projects",
  CANDIDATE_ACCEPTED: "projects",
  SUBMISSION_CREATED: "projects",
  SUBMISSION_REVIEWED: "projects",
  COMPLETED: "projects",
  BUDGET_PROPOSED: "negotiations",
  BUDGET_RESOLVED: "negotiations",
  REVIEW_SUBMITTED: "projects",
};

// project_status values -> readable copy, kept local rather than importing
// the frontend's PROJECT_STATUS_META (that file also carries UI-only tone/
// icon data this doesn't need, and the backend shouldn't depend on
// Frontend/ at all).
const STATUS_LABELS = {
  INVITED: "awaiting your response",
  ACCEPTED: "accepted",
  PENDING_FUNDS: "pending funds verification",
  FUNDS_SECURED: "funded — work can begin",
  WORK_IN_PROGRESS: "in progress",
  FILES_SUBMITTED: "submitted for review",
  PENDING_RELEASE: "pending fund release",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  DISPUTED: "disputed",
};

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status.replaceAll("_", " ").toLowerCase();
}

// The push copy for every emitProjectEvent/emitToUser type this app fires.
// role is the recipient's role relative to the project ("worker" |
// "business"), used only to pick a sensible click-through url — title/body
// stay the same for both sides, since the event itself already reads
// naturally regardless of which side you're on ("New message on X").
// Returns null for a type with nothing user-facing worth a push (none
// currently, but keeps this safe if one's ever added without updating here).
function buildProjectPushCopy(type, payload, project, role) {
  const title = project?.title ?? "your project";
  const url =
    role === "worker" ? workerNegotiationUrl(project?.id) : businessDashboardUrl(BUSINESS_TAB_BY_EVENT[type]);

  switch (type) {
    case "PROJECT_CREATED":
      return { title: "New project invite", body: `You've been invited to "${title}".`, url };
    case "MESSAGE_CREATED":
      return { title: "New message", body: `New message on "${title}".`, url };
    case "STATUS_CHANGED":
      return { title: "Project update", body: `"${title}" is now ${statusLabel(payload.status)}.`, url };
    case "CANDIDATE_ACCEPTED":
      return { title: "Project assigned", body: `"${title}" now has a worker assigned.`, url };
    case "SUBMISSION_CREATED":
      return { title: "Work submitted", body: `New submission on "${title}".`, url };
    case "SUBMISSION_REVIEWED":
      return { title: "Submission reviewed", body: `Your submission on "${title}" was reviewed.`, url };
    case "COMPLETED":
      return { title: "Project completed", body: `"${title}" has been marked complete.`, url };
    case "REVIEW_SUBMITTED":
      return { title: "New review", body: `You received a review on "${title}".`, url };
    case "BUDGET_PROPOSED":
      return { title: "New budget proposal", body: `A new budget was proposed on "${title}".`, url };
    case "BUDGET_RESOLVED":
      return {
        title: "Budget update",
        body: payload.approved ? `Your proposed budget on "${title}" was accepted.` : `Your proposed budget on "${title}" was declined.`,
        url,
      };
    default:
      return null;
  }
}

// Emitted to both participants' private rooms (so a toast lands regardless
// of which page they're on) and the project room (for anyone actively
// viewing that project). Socket emit no-ops if the socket server hasn't
// been started (e.g. under a script/test that never calls initSocket) —
// push still fires either way, see firePush above.
//
// payload.senderId (set by every event that has a real actor — a message,
// a submission) is who this event is ABOUT, not just data — the actor
// never gets their own push/notification for their own action ("You have a
// new message" for the message you just sent makes no sense). This only
// suppresses the push/persisted-notification for that one recipient; the
// socket emit still reaches them, since their own other open tabs still
// need the live update to refresh what they see.
export function emitProjectEvent(project, type, payload = {}) {
  const io = getIO();
  const event = { type, projectId: project.id, ...payload };

  if (io) {
    if (project.worker_id) io.to(userRoom(project.worker_id)).emit("project:event", event);
    io.to(userRoom(project.business_id)).emit("project:event", event);
    io.to(projectRoom(project.id)).emit("project:event", event);
  }

  const notifType = notificationTypeFor(type);
  const category = pushCategoryFor(notifType);
  if (project.worker_id && project.worker_id !== payload.senderId) {
    const workerCopy = buildProjectPushCopy(type, payload, project, "worker");
    firePush(project.worker_id, workerCopy, category);
    fireNotification(project.worker_id, workerCopy, notifType);
  }
  if (project.business_id !== payload.senderId) {
    const businessCopy = buildProjectPushCopy(type, payload, project, "business");
    firePush(project.business_id, businessCopy, category);
    fireNotification(project.business_id, businessCopy, notifType);
  }
}

// Thread-side counterpart to emitProjectEvent, for the entity-wide chat
// (see chat_threads/threads.repository.js). A thread's participants are
// always exactly the same two people (business_id, worker_id) — unlike a
// project, there's no third "anyone viewing this page" audience, so this
// only ever needs their two private user rooms, no separate thread room.
function buildThreadPushCopy(type, role) {
  const url = role === "worker" ? workerNegotiationUrl() : BUSINESS_DASHBOARD_URL;
  switch (type) {
    case "MESSAGE_CREATED":
      return { title: "New message", body: "You have a new message.", url };
    default:
      return null;
  }
}

export function emitThreadEvent(thread, type, payload = {}) {
  const io = getIO();
  const event = { type, threadId: thread.id, ...payload };

  if (io) {
    io.to(userRoom(thread.worker_id)).emit("project:event", event);
    io.to(userRoom(thread.business_id)).emit("project:event", event);
  }

  const notifType = notificationTypeFor(type);
  if (thread.worker_id !== payload.senderId) {
    const workerCopy = buildThreadPushCopy(type, "worker");
    firePush(thread.worker_id, workerCopy, "chat");
    fireNotification(thread.worker_id, workerCopy, notifType);
  }
  if (thread.business_id !== payload.senderId) {
    const businessCopy = buildThreadPushCopy(type, "business");
    firePush(thread.business_id, businessCopy, "chat");
    fireNotification(thread.business_id, businessCopy, notifType);
  }
}

// The job board's candidate events (a new invite, "this job was filled by
// someone else") target one specific user who isn't necessarily a
// participant on the project yet — an OPEN project's worker_id is null, so
// emitProjectEvent above can't reach an invited/applying worker at all.
// Same "user:<id>" room every socket already auto-joins on connect (see
// realtime/socket.js), just addressed directly instead of derived from a
// project row. Push has to look the recipient's role up (this call site
// only ever gets a bare userId, not a project row with both sides on it) —
// one extra indexed lookup, worth it to pick the right click-through url.
export function emitToUser(userId, type, payload = {}) {
  const io = getIO();
  if (io) io.to(userRoom(userId)).emit("project:event", { type, ...payload });

  const projectTitle = payload.projectTitle ?? "a job post";
  let copy;
  switch (type) {
    case "CANDIDATE_CREATED":
      copy =
        payload.source === "INVITE"
          ? { title: "You've been invited", body: `You've been invited to apply to "${projectTitle}".` }
          : { title: "New application", body: `Someone applied to "${projectTitle}".` };
      break;
    case "CANDIDATE_DECLINED":
      copy = { title: "Candidacy update", body: `There's an update on "${projectTitle}".` };
      break;
    case "JOB_FILLED":
      copy = { title: "Job filled", body: `"${projectTitle}" was filled by another candidate.` };
      break;
    default:
      copy = null;
  }
  if (!copy) return;

  usersRepo
    .findById(userId)
    .then((user) => {
      const url = user?.role === "business" ? BUSINESS_DASHBOARD_URL : WORKER_JOB_FEED_URL;
      const fullCopy = { ...copy, url };
      firePush(userId, fullCopy, "projects");
      fireNotification(userId, fullCopy, "PROJECT");
    })
    .catch((err) => console.error("[push] Could not resolve recipient role:", err));
}

// Customer Care — a new message on a support thread reaches the thread's
// owner (their other open tabs) and every currently-connected admin at
// once, so a staff member watching the inbox sees it land live without a
// manual refresh. Reuses the same "project:event" channel/shape as
// everything else real-time in this app, just with SUPPORT_MESSAGE_CREATED
// as the type. Push only goes to the thread owner — admins work from the
// live Support tab, not a device notification.
export function emitSupportMessage(thread, payload = {}) {
  const io = getIO();
  const event = { type: "SUPPORT_MESSAGE_CREATED", threadId: thread.id, ...payload };

  if (io) {
    io.to(userRoom(thread.user_id)).emit("project:event", event);
    io.to(adminRoom()).emit("project:event", event);
  }

  // No `url` — Settings' Support tab is where a reply is actually read, and
  // there's no dedicated route to deep-link to yet, so this notification is
  // informational only rather than sending the user to the home page.
  const supportCopy = { title: "Support reply", body: "You have a new message from WorkBridge Support." };
  firePush(thread.user_id, supportCopy);
  fireNotification(thread.user_id, supportCopy, "SYSTEM");
}
