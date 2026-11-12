import { cronSummary, parseCron } from '@shared/cron'
import { t } from '@/i18n'

/**
 * A cron expression in words, in the UI's own language.
 *
 * The panel deliberately sends a **descriptor** (`daily {hour, minute}`, `weekly {days,…}`, …) rather
 * than a sentence, because `src/shared` may not import a UI's i18n — so the wording is here, once, and
 * both the config editor's preview and the job card's tooltip read it. They used to word it
 * separately, which is how "every day at 03:00" and "daily, 3:00" end up on two pages of one product.
 *
 * A `custom` expression gets the neutral "custom schedule": the point of the preview is that a person
 * can check a schedule they recognise, and inventing English for `0 3 1,15 * mon` would claim more
 * than the expression says.
 */
export function jobScheduleText(expression: string): string {
  const parsed = parseCron(expression)
  if (!parsed.ok)
    return parsed.problem

  const summary = cronSummary(parsed.spec)
  const clock = (hour: number, minute: number): string => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  switch (summary.kind) {
    case 'everyMinutes':
      return t('job.scheduleEveryMinutes', { minutes: String(summary.minutes) })
    case 'hourly':
      return t('job.scheduleHourly', { minute: String(summary.minute).padStart(2, '0') })
    case 'daily':
      return t('job.scheduleDaily', { time: clock(summary.hour, summary.minute) })
    case 'weekly':
      return t('job.scheduleWeekly', {
        days: summary.days.map(day => t(`job.weekday.${day}`)).join(', '),
        time: clock(summary.hour, summary.minute),
      })
    case 'monthly':
      return t('job.scheduleMonthly', { day: String(summary.day), time: clock(summary.hour, summary.minute) })
    default:
      return t('job.scheduleCustom')
  }
}
