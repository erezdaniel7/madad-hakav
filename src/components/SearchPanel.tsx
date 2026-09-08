import { directionLabel } from '../config/routes'
import type {
  Direction,
  LineNumber,
  SearchFilters,
} from '../domain/types'

interface SearchPanelProps {
  filters: SearchFilters
  departureOptions: readonly {
    time: string
    stationName: string | null
  }[]
  timetableLoading: boolean
  timetableMessage: string | null
  loading: boolean
  plannedTripCount: number
  siriTripCount: number
  onChange: (filters: SearchFilters) => void
  onSubmit: () => void
}

export function SearchPanel({
  filters,
  departureOptions,
  timetableLoading,
  timetableMessage,
  loading,
  plannedTripCount,
  siriTripCount,
  onChange,
  onSubmit,
}: SearchPanelProps) {
  const update = <Key extends keyof SearchFilters>(
    key: Key,
    value: SearchFilters[Key],
  ) => onChange({ ...filters, [key]: value, rideId: null })

  return (
    <form
      className="search-panel"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="search-heading">
        <div className="search-icon" aria-hidden="true">
          ↗
        </div>
        <div>
          <h2>איתור נסיעה היסטורית</h2>
          <p>בחרו שירות מתוכנן כדי לצפות בביצוע בפועל</p>
        </div>
      </div>

      <div className="filter-grid">
        <label>
          <span>תאריך שירות</span>
          <input
            type="date"
            value={filters.date}
            onChange={(event) => update('date', event.target.value)}
            required
          />
        </label>

        <label>
          <span>קו</span>
          <select
            value={filters.line}
            onChange={(event) =>
              update('line', event.target.value as LineNumber)
            }
          >
            <option value="150">150</option>
            <option value="152">152</option>
          </select>
        </label>

        <label>
          <span>כיוון</span>
          <select
            value={filters.direction}
            onChange={(event) =>
              update('direction', event.target.value as Direction)
            }
          >
            <option value="to-yeruham">
              {directionLabel('to-yeruham')}
            </option>
            <option value="to-beersheva">
              {directionLabel('to-beersheva')}
            </option>
          </select>
        </label>

        <label>
          <span>שעת יציאה מתוכננת</span>
          <select
            value={filters.departureTime}
            onChange={(event) => update('departureTime', event.target.value)}
            required
            disabled={timetableLoading || departureOptions.length === 0}
          >
            <option value="">
              {timetableLoading ? 'טוען שעות…' : 'בחרו יציאה מהרשימה'}
            </option>
            {departureOptions.map(({ time, stationName }) => (
              <option value={time} key={time}>
                {time}{stationName ? ` · ${stationName}` : ''}
              </option>
            ))}
          </select>
        </label>

        <button
          className="primary-button"
          type="submit"
          disabled={loading || !filters.departureTime}
        >
          {loading ? <span className="spinner" aria-hidden="true" /> : '⌕'}
          {loading ? 'טוען נתוני נסיעה…' : 'הצג נסיעה'}
        </button>
      </div>

      <div className="timetable-hint" aria-live="polite">
        {timetableLoading
          ? 'טוען שעות יציאה מתוכננות…'
          : timetableMessage ??
          (departureOptions.length > 0
            ? `נמצאו ${departureOptions.length} יציאות מתוכננות ליום שנבחר.`
            : 'לא נמצאו יציאות מתוכננות ליום שנבחר.')}
      </div>
      {(plannedTripCount > 0 || siriTripCount > 0) && (
        <div className="service-denominator">
          <span>שירות יומי:</span>
          <strong>{plannedTripCount} יציאות מתוכננות</strong>
          <i aria-hidden="true">·</i>
          <strong>{siriTripCount} זמני יציאה שנרשמו ב-SIRI</strong>
        </div>
      )}
    </form>
  )
}
