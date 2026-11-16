import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

type Row = Record<string, unknown>;
type Notice = {
  userId: string;
  email: string;
  key: string;
  type: "event" | "task" | "daily_summary" | "test";
  sourceId?: string | null;
  occurrenceDate?: string | null;
  scheduledFor?: Date | null;
  subject: string;
  text: string;
  html: string;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type, x-notification-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Row) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function env(name: string): string {
  return Deno.env.get(name)?.trim() || "";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function value(row: Row, ...names: string[]): unknown {
  const wanted = new Set(names.map(normalize));
  const entry = Object.entries(row).find(([key]) => wanted.has(normalize(key)));
  return entry?.[1];
}

function str(row: Row, ...names: string[]): string {
  const found = value(row, ...names);
  return found === null || found === undefined ? "" : String(found);
}

function bool(row: Row, fallback: boolean, ...names: string[]): boolean {
  const found = value(row, ...names);
  if (found === null || found === undefined) return fallback;
  return found === true || found === "true" || found === 1;
}

function number(row: Row, fallback: number, ...names: string[]): number {
  const parsed = Number(value(row, ...names));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateOnly(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}

function timeOnly(value: unknown, fallback = "09:00"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const text = String(value);
  const match = text.match(/(?:T|^)(\d{2}:\d{2})/);
  return match?.[1] || fallback;
}

function parseList(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input !== "string" || !input.trim()) return [];
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // PostgreSQL text[] is returned as {a,b} by some adapters.
  }
  return input.replace(/^\{|\}$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function isMissingRelation(error: { code?: string; message?: string }): boolean {
  return ["PGRST205", "42P01"].includes(error.code || "") ||
    /could not find the table|relation .* does not exist/i.test(error.message || "");
}

function isMissingColumn(error: { code?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204";
}

async function ownedRows(admin: ReturnType<typeof createClient>, tables: string[], userId: string): Promise<Row[]> {
  let lastError: { code?: string; message?: string } | null = null;
  for (const table of tables) {
    for (const ownerColumn of ["user_id", "User_ID", "userId"]) {
      const { data, error } = await admin.from(table).select("*").eq(ownerColumn, userId);
      if (!error) return (data || []) as Row[];
      lastError = error;
      if (isMissingRelation(error) || isMissingColumn(error)) continue;
      throw error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function completionRows(admin: ReturnType<typeof createClient>, taskIds: string[]): Promise<Row[]> {
  if (!taskIds.length) return [];
  for (const table of ["to-do", "To-Do", "to_do", "todo"]) {
    for (const idColumn of ["task_id", "Task_ID", "taskId"]) {
      const { data, error } = await admin.from(table).select("*").in(idColumn, taskIds);
      if (!error) return (data || []) as Row[];
      if (isMissingRelation(error) || isMissingColumn(error)) continue;
      throw error;
    }
  }
  // If the optional completion table is unavailable, treating tasks as open
  // avoids losing deadline reminders; the setup guide calls out the dependency.
  return [];
}

function localParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function validTimeZone(candidate: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "America/Denver";
  }
}

function localDate(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function localTime(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

function zonedInstant(dateText: string, timeText: string, timeZone: string): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  // Iterative offset correction converts a local wall-clock time to UTC and
  // also follows daylight-saving changes for America/Denver and other zones.
  for (let i = 0; i < 5; i++) {
    const p = localParts(new Date(guess), timeZone);
    const observed = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour), Number(p.minute), Number(p.second),
    );
    const difference = desired - observed;
    if (!difference) break;
    guess += difference;
  }
  return new Date(guess);
}

function shiftDate(dateText: string, amount: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function weekday(dateText: string): number {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function occursOn(event: Row, dateText: string): boolean {
  const startDate = dateOnly(value(event, "date", "Date", "start_date")) ||
    dateOnly(value(event, "start_time", "Start_Time"));
  if (!startDate || dateText < startDate) return false;
  const until = dateOnly(value(event, "repeat_until", "Repeat_Until"));
  if (until && dateText > until) return false;
  if (parseList(value(event, "repeat_exceptions", "Repeat_Exceptions")).includes(dateText)) return false;
  const frequency = str(event, "repeat_frequency", "Repeat_Frequency").toLowerCase();
  if (!frequency) return dateText === startDate;
  if (frequency === "daily") return true;
  if (frequency === "weekly") {
    const days = parseList(value(event, "repeat_days", "Repeat_Days")).map(Number);
    return days.includes(weekday(dateText));
  }
  if (frequency === "monthly") return Number(dateText.slice(8, 10)) === Number(startDate.slice(8, 10));
  return false;
}

function escapeHtml(input: unknown): string {
  return String(input ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]!));
}

function formattedDate(dateText: string, timeZone: string): string {
  const instant = zonedInstant(dateText, "12:00", timeZone);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(instant);
}

function emailTransport() {
  const username = env("GMAIL_SMTP_USER");
  const password = env("GMAIL_SMTP_APP_PASSWORD").replace(/\s/g, "");
  if (!username || !password) throw new Error("Gmail sending is not configured in Supabase yet.");
  const port = Number(env("GMAIL_SMTP_PORT") || "465");
  if (port !== 465) throw new Error("Use Gmail secure SMTP port 465 for this function.");
  return nodemailer.createTransport({
    host: env("GMAIL_SMTP_HOST") || "smtp.gmail.com",
    port,
    secure: true,
    auth: { user: username, pass: password },
  });
}

function fromAddress(username: string): string {
  const configured = env("GMAIL_FROM");
  return configured || `Upnext reminders <${username}>`;
}

async function sendEmail(to: string, subject: string, text: string, html: string): Promise<void> {
  const transport = emailTransport();
  await transport.sendMail({ from: fromAddress(env("GMAIL_SMTP_USER")), to, subject, text, html });
}

async function claim(admin: ReturnType<typeof createClient>, notice: Notice): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_notification_delivery", {
    p_user_id: notice.userId,
    p_dedupe_key: notice.key,
    p_notification_type: notice.type,
    p_source_id: notice.sourceId || null,
    p_occurrence_date: notice.occurrenceDate || null,
    p_scheduled_for: notice.scheduledFor?.toISOString() || null,
  });
  if (error) throw error;
  return data === true;
}

async function deliver(admin: ReturnType<typeof createClient>, notice: Notice): Promise<boolean> {
  if (!(await claim(admin, notice))) return false;
  try {
    await sendEmail(notice.email, notice.subject, notice.text, notice.html);
    const { error } = await admin.from("notification_delivery_log")
      .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
      .eq("user_id", notice.userId).eq("dedupe_key", notice.key);
    if (error) throw error;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("notification_delivery_log")
      .update({ status: "failed", last_error: message.slice(0, 1000) })
      .eq("user_id", notice.userId).eq("dedupe_key", notice.key);
    console.error("Notification delivery failed", notice.type, notice.userId, message);
    return false;
  }
}

function taskStatus(rows: Row[]): Map<string, boolean> {
  return new Map(rows.map((row) => [
    str(row, "task_id", "Task_ID", "taskId"),
    bool(row, false, "is_complete", "Is_Complete", "isComplete"),
  ]));
}

function taskName(row: Row): string {
  return str(row, "task_title", "Task_Title", "title") || "Untitled task";
}

function eventName(row: Row): string {
  return str(row, "event_title", "Event_Title", "title") || "Untitled event";
}

function taskSettings(row: Row | undefined, preferences: Row): {
  enabled: boolean;
  date: string;
  time: string;
} {
  return {
    enabled: row ? bool(row, true, "reminder_enabled") : true,
    date: dateOnly(row ? value(row, "task_reminder_date") : null),
    time: timeOnly(row ? value(row, "task_reminder_time") : null, str(preferences, "task_reminder_time") || "18:00"),
  };
}

function eventReminderText(event: Row, date: string, time: string, zone: string, leadMinutes: number): { text: string; html: string } {
  const title = eventName(event);
  const when = `${formattedDate(date, zone)} at ${time}`;
  const lead = leadMinutes === 0 ? "now" : leadMinutes < 60 ? `${leadMinutes} minutes` : leadMinutes % 1440 === 0 ? `${leadMinutes / 1440} days` : leadMinutes % 60 === 0 ? `${leadMinutes / 60} hours` : `${leadMinutes} minutes`;
  return {
    text: `${title} is scheduled for ${when} (${zone}). Your reminder setting is ${lead === "now" ? "at the event time" : `${lead} before the event`}.\n\nOpen Upnext: https://christianburfeind.github.io/IS401_CalendarAppProject/#summary`,
    html: `<p>Reminder for <strong>${escapeHtml(title)}</strong>.</p><p>Scheduled for ${escapeHtml(when)} (${escapeHtml(zone)}). Your reminder setting is ${lead === "now" ? "at the event time" : `${escapeHtml(lead)} before the event`}.</p><p><a href="https://christianburfeind.github.io/IS401_CalendarAppProject/#summary">Open Upnext</a></p>`,
  };
}

function taskReminderText(task: Row, date: string, time: string, zone: string): { text: string; html: string } {
  const title = taskName(task);
  const when = `${formattedDate(date, zone)} at ${time}`;
  return {
    text: `Reminder: ${title}\nScheduled for ${when} (${zone}).\n\nOpen Upnext: https://christianburfeind.github.io/IS401_CalendarAppProject/#todo`,
    html: `<p>Reminder for <strong>${escapeHtml(title)}</strong>.</p><p>Scheduled for ${escapeHtml(when)} (${escapeHtml(zone)}).</p><p><a href="https://christianburfeind.github.io/IS401_CalendarAppProject/#todo">Open Upnext</a></p>`,
  };
}

function summaryContent(date: string, zone: string, events: Array<{ row: Row; date: string; time: string }>, tasks: Row[]): { text: string; html: string } {
  const eventLines = events.length
    ? events.map((entry) => `• ${entry.time} — ${eventName(entry.row)}`).join("\n")
    : "No events scheduled.";
  const taskLines = tasks.length
    ? tasks.map((row) => `• ${taskName(row)}${dateOnly(value(row, "date", "Date")) < date ? " (overdue)" : ""}`).join("\n")
    : "No unfinished tasks due today or earlier.";
  const eventHtml = events.length
    ? `<ul>${events.map((entry) => `<li>${escapeHtml(entry.time)} — ${escapeHtml(eventName(entry.row))}</li>`).join("")}</ul>`
    : "<p>No events scheduled.</p>";
  const taskHtml = tasks.length
    ? `<ul>${tasks.map((row) => `<li>${escapeHtml(taskName(row))}${dateOnly(value(row, "date", "Date")) < date ? " <em>(overdue)</em>" : ""}</li>`).join("")}</ul>`
    : "<p>No unfinished tasks due today or earlier.</p>";
  return {
    text: `${formattedDate(date, zone)}\n\nTODAY'S EVENTS\n${eventLines}\n\nUNFINISHED TASKS\n${taskLines}\n\nOpen Upnext: https://christianburfeind.github.io/IS401_CalendarAppProject/#summary`,
    html: `<h2>${escapeHtml(formattedDate(date, zone))}</h2><h3>Today's events</h3>${eventHtml}<h3>Unfinished tasks</h3>${taskHtml}<p><a href="https://christianburfeind.github.io/IS401_CalendarAppProject/#summary">Open Upnext</a></p>`,
  };
}

async function runScheduler(admin: ReturnType<typeof createClient>): Promise<Row> {
  const { data: preferences, error } = await admin.from("notification_preferences")
    .select("*").eq("email_enabled", true);
  if (error) throw error;

  const now = new Date();
  let sent = 0;
  let considered = 0;
  for (const preference of (preferences || []) as Row[]) {
    const userId = str(preference, "user_id");
    if (!userId) continue;
    try {
      const { data: identity, error: authError } = await admin.auth.admin.getUserById(userId);
      if (authError) throw authError;
      const email = identity.user?.email || "";
      if (!email) continue;

      const zone = validTimeZone(str(preference, "time_zone") || "America/Denver");
      const today = localDate(now, zone);
      const itemSettingsResult = await admin.from("notification_item_settings")
        .select("*").eq("user_id", userId);
      if (itemSettingsResult.error) throw itemSettingsResult.error;
      const settings = new Map<string, Row>(
        ((itemSettingsResult.data || []) as Row[]).map((row) => [
          `${str(row, "item_type")}:${str(row, "item_id")}`,
          row,
        ]),
      );

      const [events, tasks] = await Promise.all([
        ownedRows(admin, ["events", "Events"], userId),
        ownedRows(admin, ["tasks", "Tasks"], userId),
      ]);
      const taskIds = tasks.map((row) => str(row, "task_id", "Task_ID", "taskId")).filter(Boolean);
      const doneRows = await completionRows(admin, taskIds);
      const done = taskStatus(doneRows);
      const completedSet = new Set([...done.entries()].filter(([, value]) => value).map(([id]) => id));

      if (bool(preference, true, "event_reminders_enabled")) {
        for (const event of events) {
          const eventId = str(event, "event_id", "Event_ID", "id");
          if (!eventId) continue;
          const itemSetting = settings.get(`event:${eventId}`);
          if (itemSetting && !bool(itemSetting, true, "reminder_enabled")) continue;
          const lead = itemSetting && value(itemSetting, "event_lead_minutes") !== null
            ? number(itemSetting, 15, "event_lead_minutes")
            : number(preference, 15, "event_lead_minutes");
          for (let offset = 0; offset <= 31; offset++) {
            const occurrenceDate = shiftDate(today, offset);
            if (!occursOn(event, occurrenceDate)) continue;
            const allDay = bool(event, false, "is_all_day", "all_day");
            const eventTime = allDay ? "09:00" : timeOnly(value(event, "start_time", "Start_Time", "time"));
            const starts = zonedInstant(occurrenceDate, eventTime, zone);
            if (starts <= now && !(lead === 0 && now.getTime() - starts.getTime() <= 5 * 60_000)) continue;
            const scheduled = new Date(starts.getTime() - lead * 60_000);
            if (scheduled > now) continue;
            const displayLead = lead;
            const content = eventReminderText(event, occurrenceDate, eventTime, zone, displayLead);
            considered++;
            if (await deliver(admin, {
              userId, email, key: `event:${eventId}:${occurrenceDate}`, type: "event",
              sourceId: eventId, occurrenceDate, scheduledFor: scheduled,
              subject: `Event reminder: ${eventName(event)}`,
              ...content,
            })) sent++;
          }
        }
      }

      if (bool(preference, true, "task_reminders_enabled")) {
        for (const task of tasks) {
          const taskId = str(task, "task_id", "Task_ID", "id");
          if (!taskId || completedSet.has(taskId)) continue;
          const itemSetting = settings.get(`task:${taskId}`);
          const rule = taskSettings(itemSetting, preference);
          if (!rule.enabled) continue;
          const taskDate = dateOnly(value(task, "date", "Date"));
          const reminderDate = rule.date || taskDate;
          if (!reminderDate || reminderDate < today || reminderDate > today) continue;
          const scheduled = zonedInstant(reminderDate, rule.time, zone);
          if (scheduled > now) continue;
          const content = taskReminderText(task, reminderDate, rule.time, zone);
          considered++;
          if (await deliver(admin, {
            userId, email,
            key: `task:${taskId}:${reminderDate}:${rule.time}`,
            type: "task", sourceId: taskId, occurrenceDate: reminderDate,
            scheduledFor: scheduled,
            subject: `Task reminder: ${taskName(task)}`,
            ...content,
          })) sent++;
        }
      }

      if (bool(preference, false, "daily_summary_enabled")) {
        const summaryTime = timeOnly(value(preference, "daily_summary_time"), "08:00");
        if (localTime(now, zone) >= summaryTime) {
          const todayEvents: Array<{ row: Row; date: string; time: string }> = [];
          for (const event of events) {
            if (!occursOn(event, today)) continue;
            todayEvents.push({
              row: event,
              date: today,
              time: bool(event, false, "is_all_day", "all_day")
                ? "All day"
                : timeOnly(value(event, "start_time", "Start_Time", "time")),
            });
          }
          todayEvents.sort((a, b) => a.time.localeCompare(b.time));
          const incompleteTasks = tasks.filter((task) => {
            const id = str(task, "task_id", "Task_ID", "id");
            const due = dateOnly(value(task, "date", "Date"));
            return id && !completedSet.has(id) && due && due <= today;
          });
          const content = summaryContent(today, zone, todayEvents, incompleteTasks);
          considered++;
          if (await deliver(admin, {
            userId, email, key: `daily-summary:${today}`, type: "daily_summary",
            occurrenceDate: today, scheduledFor: zonedInstant(today, summaryTime, zone),
            subject: `Your Upnext daily summary · ${formattedDate(today, zone)}`,
            ...content,
          })) sent++;
        }
      }
    } catch (error) {
      console.error("Notification scheduler user failed", userId, error instanceof Error ? error.message : String(error));
    }
  }
  return { ok: true, users: (preferences || []).length, considered, sent };
}

function escapeEmailText(text: string): string {
  return `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#24334a">${text.split("\n").map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`).join("")}</div>`;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return reply(405, { error: "Use POST." });

  const projectUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!projectUrl || !serviceKey) return reply(500, { error: "Supabase server access is not configured." });
  const admin = createClient(projectUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cronSecret = env("NOTIFICATION_CRON_SECRET");
  if (cronSecret && request.headers.get("x-notification-cron-secret") === cronSecret) {
    try {
      return reply(200, await runScheduler(admin));
    } catch (error) {
      console.error("Notification scheduler failed", error instanceof Error ? error.message : String(error));
      return reply(500, { error: "The notification scheduler could not finish." });
    }
  }

  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return reply(401, { error: "Sign in before requesting an email test." });
  const { data: identity, error: identityError } = await admin.auth.getUser(token);
  if (identityError || !identity.user?.id || !identity.user.email) {
    return reply(401, { error: "Your session expired. Sign in again and retry." });
  }

  let body: Row;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "Invalid request." });
  }
  if (body.action !== "test") return reply(400, { error: "Unsupported notification action." });

  try {
    const user = identity.user;
    const email = user.email;
    const key = `test:${Math.floor(Date.now() / 60_000)}`;
    const content = {
      text: "This is a test email from Upnext. Your email notification connection is working.\n\nOpen Upnext: https://christianburfeind.github.io/IS401_CalendarAppProject/#settings",
      html: escapeEmailText("This is a test email from Upnext. Your email notification connection is working.") +
        '<p><a href="https://christianburfeind.github.io/IS401_CalendarAppProject/#settings">Open Upnext settings</a></p>',
    };
    const sent = await deliver(admin, {
      userId: user.id, email, key, type: "test", subject: "Your Upnext email test",
      ...content,
    });
    return reply(200, { sent, message: sent ? "Test email sent." : "A test email was already sent recently." });
  } catch (error) {
    console.error("Email test failed", error instanceof Error ? error.message : String(error));
    return reply(500, { error: "The test email could not be sent. Check the Supabase function logs and Gmail settings." });
  }
});
