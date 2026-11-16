# Upnext email notifications

This adds opt-in event reminders, task reminders, and a morning email summary. It uses the address on each user's Supabase Auth account as the recipient. It does not change signup confirmation or Supabase Auth email settings.

## 1. Install the notification tables

In the existing Supabase project, open **SQL Editor**, paste all of `notifications-setup.sql`, and run it. It is additive: it creates notification-specific tables and policies without changing tasks, events, the existing Settings table, or Auth verification. Existing accounts start with email notifications off.

## 2. Prepare the Gmail sender

Use the Gmail account made for Upnext. Turn on Google's 2-Step Verification, then create an App Password. The App Password is different from the account's normal password. Do not put it in `index.html`, GitHub, or a message to anyone.

## 3. Add server-side secrets

In Supabase, open **Edge Functions → Secrets** and add:

| Secret name | Value |
| --- | --- |
| `GMAIL_SMTP_HOST` | `smtp.gmail.com` |
| `GMAIL_SMTP_PORT` | `465` |
| `GMAIL_SMTP_USER` | The Upnext Gmail address |
| `GMAIL_SMTP_APP_PASSWORD` | The Gmail App Password |
| `GMAIL_FROM` | `Upnext reminders <your-gmail-address>` |
| `NOTIFICATION_CRON_SECRET` | A long random value you create; save it for Step 5 |

The function uses secure SMTP on port 465. The Gmail address stays visible to recipients, with “Upnext reminders” as its display name.

## 4. Deploy the sender and scheduler function

With the Supabase CLI installed, run these commands from the project folder:

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy notification-scheduler --no-verify-jwt
```

Replace `YOUR_PROJECT_REF` with the project reference shown in the Supabase project URL. The function checks a signed-in user's session before sending a test message and checks the private scheduler secret before processing reminders.

## 5. Schedule the checks

In Supabase **Vault**, create these two secrets:

- `notification_function_url` — `https://YOUR_PROJECT_REF.supabase.co/functions/v1/notification-scheduler`
- `notification_cron_secret` — the exact same random value as `NOTIFICATION_CRON_SECRET` from Step 3

Then run all of `notifications-cron.sql` in the SQL Editor. Supabase Cron will call the function once a minute; the function sends only items that are due. Its delivery log prevents duplicate event reminders, task reminders, and daily summaries if a scheduled call overlaps or is retried.

## 6. Turn on and personalize email in Upnext

Open **Settings → Email notifications** while signed in. Email is off until the user opts in. The settings include:

- A timezone, defaulted to Mountain Time (`America/Denver`), with a device-timezone option.
- Event reminders with presets or a custom number of minutes before each event. A custom event setting can override the user's default.
- Task reminders at a selected date and time, defaulting to 6:00 p.m. on the task's date. A task can be snoozed to tomorrow without creating another task.
- An optional daily summary time, defaulting to 8:00 a.m. The summary includes today's events and unfinished tasks due today or earlier.
- A **Send test email** button. It sends only to the signed-in user's own Supabase Auth email.

The notification worker never creates or rolls over task records. Skipping a task does not generate repeat task-reminder emails; unfinished tasks can still appear in the daily summary. Recurring event reminders use the existing event repeat rules and exceptions.

## Troubleshooting

- If the test message fails, check the Gmail App Password, the function secrets, and the **notification-scheduler** function logs in Supabase.
- If no email arrives at the chosen time, check the Cron job's run history and the notification delivery log.
- Gmail is intended here for a low-volume assignment demo; Google's consumer Gmail sending limit is 500 messages per day.
- Keep `GMAIL_SMTP_APP_PASSWORD` and `NOTIFICATION_CRON_SECRET` out of all frontend files and commits.
