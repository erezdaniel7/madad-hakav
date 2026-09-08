import type { StopPassage, VehicleLocation } from '../domain/types'
import { distanceMeters } from '../utils/geo'
import { formatLocalDateTime, localTimeValue } from '../utils/time'

interface SummaryCardsProps {
  passages: readonly StopPassage[]
  points: readonly VehicleLocation[]
}

function delayText(delay: number | null): string {
  if (delay === null) return 'אין נתון'
  if (delay === 0) return 'בזמן'
  return delay > 0 ? `+${delay} דק׳` : `−${Math.abs(delay)} דק׳`
}

function delayMinutes(planned: string | null, actual: string | null): number | null {
  if (!planned || !actual) return null
  return Math.trunc(
    (new Date(actual).getTime() - new Date(planned).getTime()) / 60_000,
  )
}

function timePair(
  planned: string | null,
  actual: string | null,
  actualLabel: string,
): string {
  const plannedText = planned ? localTimeValue(planned) : '—'
  const actualText = actual ? localTimeValue(actual) : '—'
  return `מתוכנן ${plannedText} · ${actualLabel} ${actualText}`
}

export function SummaryCards({ passages, points }: SummaryCardsProps) {
  const origin = passages[0]
  const destination = passages.at(-1)
  const firstPoint = points[0]
  const lastPoint = points.at(-1)
  const plannedStart = origin?.stop.plannedArrivalTime ?? firstPoint?.scheduledStartTime ?? null
  const observedStart = origin?.point?.recordedAtTime ?? null
  const departureDelay = delayMinutes(plannedStart, observedStart)
  const firstObservedStopIndex = passages.findIndex((passage) => passage.point)
  const firstObservedStop =
    firstObservedStopIndex >= 0 ? passages[firstObservedStopIndex] : null
  const plannedEnd = destination?.stop.plannedArrivalTime ?? null
  const observedEnd = destination?.point?.recordedAtTime ?? null
  const arrivalDelay = delayMinutes(plannedEnd, observedEnd)
  const distanceToDestination =
    !observedEnd &&
      lastPoint &&
      destination?.stop.lat !== null &&
      destination?.stop.lon !== null &&
      destination !== undefined
      ? distanceMeters(
        { lat: destination.stop.lat, lon: destination.stop.lon },
        lastPoint,
      )
      : null
  const durationMinutes =
    firstPoint && lastPoint
      ? Math.max(
        0,
        Math.round(
          (new Date(lastPoint.recordedAtTime).getTime() -
            new Date(firstPoint.recordedAtTime).getTime()) /
          60_000,
        ),
      )
      : null
  const matchedStops = passages.filter((passage) => passage.point).length
  const coverage =
    passages.length > 0 ? Math.round((matchedStops / passages.length) * 100) : 0

  return (
    <section className="summary-grid" aria-label="סיכום נסיעה">
      <article>
        <span className="summary-icon delay">◷</span>
        <div>
          <span>{origin?.point ? 'איחור ביציאה' : 'יציאה מתחנת המוצא'}</span>
          {origin?.point ? (
            <>
              <strong>{delayText(departureDelay)}</strong>
              <small>{timePair(plannedStart, observedStart, 'בפועל')}</small>
            </>
          ) : (
            <>
              <strong>לא ניתנת לאימות</strong>
              <small>
                {firstObservedStop
                  ? `ה-GPS התחיל בתחנה ${firstObservedStopIndex + 1}; האיחור שם היה ${delayText(firstObservedStop.delayMinutes)}`
                  : 'לא התקבל GPS בתחנת המוצא או בתחנות המסלול'}
              </small>
            </>
          )}
        </div>
      </article>
      <article>
        <span className="summary-icon coverage">◒</span>
        <div>
          <span>משך וכיסוי</span>
          <strong>
            {durationMinutes === null ? 'אין נתון' : `${durationMinutes} דק׳`}
          </strong>
          <small>{coverage}% מהתחנות זוהו</small>
        </div>
      </article>
      <article>
        <span className="summary-icon location">⌖</span>
        <div>
          <span>תצפית אחרונה</span>
          <strong>
            {lastPoint ? formatLocalDateTime(lastPoint.recordedAtTime) : 'אין נתון'}
          </strong>
          <small dir="ltr">
            {lastPoint
              ? `${lastPoint.lat.toFixed(5)}, ${lastPoint.lon.toFixed(5)}`
              : '—'}
          </small>
        </div>
      </article>
      <article>
        <span className="summary-icon destination">✓</span>
        <div>
          <span>הגעה ליעד</span>
          <strong>
            {destination?.point ? delayText(arrivalDelay) : 'לא זוהתה'}
          </strong>
          <small>
            {timePair(
              plannedEnd,
              observedEnd ?? lastPoint?.recordedAtTime ?? null,
              destination?.point ? 'בפועל' : 'GPS אחרון',
            )}
            {distanceToDestination !== null
              ? ` · ${distanceToDestination >= 1_000
                ? `${(distanceToDestination / 1_000).toFixed(1)} ק״מ`
                : `${Math.round(distanceToDestination)} מ׳`
              } מהיעד`
              : ''}
          </small>
        </div>
      </article>
    </section>
  )
}
