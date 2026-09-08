import type { RideOption } from '../domain/types'
import { formatLocalTime } from '../utils/time'
import { DATA_SOURCE_TOOLTIP } from '../config/dataSources'

interface RideSelectorProps {
  rides: readonly RideOption[]
  selectedRideId: number | null
  isToday: boolean
  onSelect: (rideId: number) => void
}

export function RideSelector({
  rides,
  selectedRideId,
  isToday,
  onSelect,
}: RideSelectorProps) {
  if (rides.length === 0) {
    return null
  }

  const relationLabel = (ride: RideOption): string => {
    if (ride.relation === 'unmarked') return 'לא סומנה שעת התחלה'
    if (ride.relation === 'target') return 'נסיעת היעד'
    if (ride.relation === 'following') {
      return `נסיעה עוקבת · +${ride.scheduleDeltaMinutes} דק׳`
    }
    return `נסיעה סמוכה · ${ride.scheduleDeltaMinutes} דק׳`
  }

  const dataLabel = (ride: RideOption): string => {
    if (ride.pointCount > 0) return 'נתוני GPS זמינים'
    return isToday ? 'אין נתונים עדיין' : 'לא נצפתה ב-GPS / ייתכן שבוטלה'
  }

  const sourceLabel = (ride: RideOption): string => {
    const sources = ['SIRI']
    if (ride.sources.includes('gps')) {
      sources.push(isToday ? 'GPS חי' : 'GPS היסטורי')
    }
    return `מקור: ${sources.join(' + ')}`
  }

  return (
    <section className="ride-selector" aria-labelledby="ride-selector-title">
      <div>
        <span className="eyebrow">זהויות SIRI נפרדות</span>
        <h2 id="ride-selector-title">בחרו נסיעה להצגה</h2>
      </div>
      <div className="ride-options">
        {rides.map((ride) => (
          <button
            type="button"
            className={ride.id === selectedRideId ? 'selected' : ''}
            onClick={() => onSelect(ride.id)}
            key={ride.id}
          >
            <strong>
              {ride.scheduledStartTime
                ? formatLocalTime(ride.scheduledStartTime)
                : 'ללא שעת התחלה'}
            </strong>
            <span className={`ride-relation ${ride.relation}`}>
              {relationLabel(ride)}
            </span>
            <span dir="ltr">SIRI #{ride.id}</span>
            <small>
              לוחית רישוי {ride.vehicleRef ?? 'לא ידועה'} · {ride.pointCount} נקודות
            </small>
            <small className={ride.pointCount === 0 ? 'ride-data-missing' : ''}>
              {dataLabel(ride)}
            </small>
            <small className="data-source-label" title={DATA_SOURCE_TOOLTIP}>
              {sourceLabel(ride)}
            </small>
          </button>
        ))}
      </div>
    </section>
  )
}
