import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import 'leaflet/dist/leaflet.css'
import './App.css'
import {
  deduplicateLocations,
  fetchGtfsStopCodes,
  fetchSiriDepartureTimes,
  fetchSiriRides,
  fetchSiriRideStopOrders,
  fetchTimetable,
  fetchVehicleLocations,
} from './api/openBus'
import { RideSelector } from './components/RideSelector'
import { EvidencePanel } from './components/EvidencePanel'
import { SearchPanel } from './components/SearchPanel'
import { StopsTable } from './components/StopsTable'
import { SummaryCards } from './components/SummaryCards'
import { TripMap } from './components/TripMap'
import { DATA_SOURCE_TOOLTIP } from './config/dataSources'
import { getRoute } from './config/routes'
import {
  estimateStopPassages,
  STOP_MATCH_THRESHOLD_METERS,
} from './domain/matching'
import {
  analyzeTripEvidence,
  buildRideOptions,
  preferredTargetRideId,
  stopsForSelectedRide,
} from './domain/tripAnalysis'
import type {
  Direction,
  LineNumber,
  SearchFilters,
  SiriRideSummary,
  SiriRideStopInfo,
  TimetableStop,
  VehicleLocation,
} from './domain/types'
import {
  addDays,
  jerusalemLocalToDate,
  jerusalemToday,
  localTimeValue,
  scheduledFollowingWindow,
  scheduledStartWindow,
  serviceDayWindow,
} from './utils/time'

type LoadStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error'

const MOBILE_SHEET_MIN_HEIGHT = 144

function clampSheetHeight(height: number): number {
  return Math.min(
    Math.max(height, MOBILE_SHEET_MIN_HEIGHT),
    Math.max(MOBILE_SHEET_MIN_HEIGHT, window.innerHeight - 16),
  )
}

function isLine(value: string | null): value is LineNumber {
  return value === '150' || value === '152'
}

function isDirection(value: string | null): value is Direction {
  return value === 'to-yeruham' || value === 'to-beersheva'
}

function getInitialFilters(): SearchFilters {
  const params = new URLSearchParams(window.location.search)
  const line = params.get('line')
  const direction = params.get('direction')
  const ride = Number(params.get('ride'))
  return {
    date: params.get('date') ?? jerusalemToday(),
    line: isLine(line) ? line : '150',
    direction: isDirection(direction) ? direction : 'to-yeruham',
    departureTime: params.get('time') ?? '',
    rideId: Number.isInteger(ride) && ride > 0 ? ride : null,
  }
}

function writeUrl(filters: SearchFilters, push = false): void {
  const params = new URLSearchParams()
  params.set('date', filters.date)
  params.set('line', filters.line)
  params.set('direction', filters.direction)
  if (filters.departureTime) params.set('time', filters.departureTime)
  if (filters.rideId) params.set('ride', String(filters.rideId))
  const url = `${window.location.pathname}?${params}`
  if (push) window.history.pushState(null, '', url)
  else window.history.replaceState(null, '', url)
}

function selectStopsForDeparture(
  timetable: readonly TimetableStop[],
  departureTime: string,
): TimetableStop[] {
  const departures = timetable.filter(
    (stop) =>
      stop.lineStartTime && localTimeValue(stop.lineStartTime) === departureTime,
  )
  const gtfsRideId = departures[0]?.gtfsRideId
  return gtfsRideId
    ? departures.filter((stop) => stop.gtfsRideId === gtfsRideId)
    : departures
}

function shiftTimetableToDate(
  timetable: readonly TimetableStop[],
  targetDate: string,
): TimetableStop[] {
  const shiftTimestamp = (timestamp: string | null): string | null => {
    if (!timestamp) return null
    const time = localTimeValue(timestamp)
    return jerusalemLocalToDate(targetDate, `${time}:00`).toISOString()
  }

  return timetable.map((stop) => ({
    ...stop,
    plannedArrivalTime: shiftTimestamp(stop.plannedArrivalTime),
    lineStartTime: shiftTimestamp(stop.lineStartTime),
  }))
}

function App() {
  const initial = useMemo(getInitialFilters, [])
  const [filters, setFilters] = useState<SearchFilters>(initial)
  const [timetable, setTimetable] = useState<TimetableStop[]>([])
  const [siriDepartureTimes, setSiriDepartureTimes] = useState<string[]>([])
  const [comparisonRides, setComparisonRides] = useState<SiriRideSummary[]>([])
  const [timetableLoading, setTimetableLoading] = useState(false)
  const [timetableMessage, setTimetableMessage] = useState<string | null>(null)
  const [locations, setLocations] = useState<VehicleLocation[]>([])
  const [rideStopOrders, setRideStopOrders] = useState<
    Map<number, SiriRideStopInfo>
  >(
    new Map(),
  )
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isDelayed, setIsDelayed] = useState(false)
  const [selectedStopId, setSelectedStopId] = useState<number | null>(null)
  const [searchExpanded, setSearchExpanded] = useState(!initial.departureTime)
  const [sheetHeight, setSheetHeight] = useState(() =>
    clampSheetHeight(window.innerHeight * 0.46),
  )
  const [sheetDragging, setSheetDragging] = useState(false)
  const sheetDragCleanup = useRef<(() => void) | null>(null)
  const tripController = useRef<AbortController | null>(null)
  const hasAutoLoaded = useRef(false)

  const route = getRoute(filters.line, filters.direction)

  useEffect(() => {
    const handleResize = () => {
      setSheetHeight((current) => clampSheetHeight(current))
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      sheetDragCleanup.current?.()
    }
  }, [])

  useEffect(() => {
    writeUrl(filters)
  }, [filters])

  useEffect(() => {
    const controller = new AbortController()
    setTimetableLoading(true)
    setTimetableMessage(null)
    setTimetable([])
    setSiriDepartureTimes([])

    const routeConfig = getRoute(filters.line, filters.direction)
    const window = serviceDayWindow(filters.date)

    Promise.allSettled([
      fetchTimetable(routeConfig.lineRef, window, controller.signal),
      fetchSiriDepartureTimes(routeConfig.lineRef, window, controller.signal),
    ])
      .then(async ([timetableResult, siriResult]) => {
        if (controller.signal.aborted) return
        let rows = timetableResult.status === 'fulfilled' ? timetableResult.value : []
        let timetableSourceDate = filters.date
        const siriTimes = siriResult.status === 'fulfilled' ? siriResult.value : []

        if (rows.length === 0 && siriTimes.length > 0) {
          const templateDate = addDays(filters.date, -7)
          try {
            const template = await fetchTimetable(
              routeConfig.lineRef,
              serviceDayWindow(templateDate),
              controller.signal,
            )
            timetableSourceDate = templateDate
            rows = shiftTimetableToDate(template, filters.date)
          } catch (caught: unknown) {
            if (caught instanceof DOMException && caught.name === 'AbortError') return
          }
        }

        if (controller.signal.aborted) return
        const cities = rows.flatMap((stop) => (stop.city ? [stop.city] : []))
        if (cities.length > 0) {
          try {
            const stopCodes = await fetchGtfsStopCodes(
              timetableSourceDate,
              cities,
              controller.signal,
            )
            rows = rows.map((stop) => ({
              ...stop,
              code: stopCodes.get(stop.id) ?? null,
            }))
          } catch (caught: unknown) {
            if (caught instanceof DOMException && caught.name === 'AbortError') return
          }
        }

        if (controller.signal.aborted) return
        setTimetable(rows)
        setSiriDepartureTimes(siriTimes)

        if (siriTimes.length > 0 && timetableResult.status === 'fulfilled' && timetableResult.value.length === 0) {
          setTimetableMessage(
            rows.length > 0
              ? 'מוצגות יציאות SIRI שנקלטו ב-GPS. רשימת התחנות מבוססת על אותו יום בשבוע הקודם.'
              : 'מוצגות יציאות SIRI שנקלטו בנתוני ה-GPS; רשימת התחנות המתוכננת עדיין אינה זמינה.',
          )
        } else if (siriTimes.length === 0 && rows.length === 0) {
          setTimetableMessage(
            'לא נמצאו לוח זמנים מתוכנן או נסיעות GPS ליום הזה.',
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setTimetableLoading(false)
      })

    return () => controller.abort()
  }, [filters.date, filters.direction, filters.line])

  const loadTrip = useCallback(async (search: SearchFilters) => {
    tripController.current?.abort()
    const controller = new AbortController()
    tripController.current = controller
    setStatus('loading')
    setError(null)
    setIsDelayed(false)
    setLocations([])
    setComparisonRides([])
    setRideStopOrders(new Map())
    setSelectedStopId(null)
    const delayTimer = window.setTimeout(() => setIsDelayed(true), 4_000)

    try {
      const routeConfig = getRoute(search.line, search.direction)
      const targetWindow = scheduledStartWindow(
        search.date,
        search.departureTime,
      )
      const followingWindow = scheduledFollowingWindow(
        search.date,
        search.departureTime,
      )
      const [targetRows, followingRows, targetRides, followingRides] =
        await Promise.all([
          fetchVehicleLocations(
            routeConfig.lineRef,
            targetWindow,
            controller.signal,
          ),
          fetchVehicleLocations(
            routeConfig.lineRef,
            followingWindow,
            controller.signal,
          ),
          fetchSiriRides(routeConfig.lineRef, targetWindow, controller.signal),
          fetchSiriRides(
            routeConfig.lineRef,
            followingWindow,
            controller.signal,
          ),
        ])
      const rows = [...targetRows, ...followingRows]
      const siriRides = [
        ...new Map(
          [...targetRides, ...followingRides].map((ride) => [ride.id, ride]),
        ).values(),
      ]
      const cleanRows = deduplicateLocations(rows).sort(
        (a, b) =>
          new Date(a.recordedAtTime).getTime() -
          new Date(b.recordedAtTime).getTime(),
      )
      setLocations(cleanRows)
      setComparisonRides(siriRides)
      const targetScheduledTime = jerusalemLocalToDate(
        search.date,
        `${search.departureTime}:00`,
      )
      const rides = buildRideOptions(cleanRows, targetScheduledTime)
      const stopOrders = await fetchSiriRideStopOrders(
        rides.map((ride) => ride.id),
        controller.signal,
      ).catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          throw caught
        }
        return new Map<number, SiriRideStopInfo>()
      })
      setRideStopOrders(stopOrders)
      const requestedRideExists = rides.some((ride) => ride.id === search.rideId)
      const selectedRideId = requestedRideExists ? search.rideId : null
      setFilters((current) => ({ ...current, rideId: selectedRideId }))
      setStatus(
        cleanRows.length > 0 || siriRides.length > 0 ? 'success' : 'empty',
      )
      if (cleanRows.length > 0 || siriRides.length > 0) {
        setSearchExpanded(false)
      }
    } catch (caught: unknown) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(
        caught instanceof Error
          ? caught.message
          : 'אירעה שגיאה לא צפויה בעת טעינת נתוני הנסיעה.',
      )
      setStatus('error')
    } finally {
      window.clearTimeout(delayTimer)
      if (!controller.signal.aborted) setIsDelayed(false)
    }
  }, [])

  useEffect(() => {
    if (!hasAutoLoaded.current && initial.departureTime) {
      hasAutoLoaded.current = true
      void loadTrip(initial)
    }
  }, [initial, loadTrip])

  const departureOptions = useMemo(
    () => {
      const options = new Map<string, string | null>()
      for (const stop of timetable) {
        if (!stop.lineStartTime) continue
        const time = localTimeValue(stop.lineStartTime)
        if (!options.has(time)) options.set(time, stop.name)
      }
      return [...options].sort(([a], [b]) => a.localeCompare(b)).map(
        ([time, stationName]) => ({ time, stationName }),
      )
    },
    [timetable],
  )
  const plannedTripCount = useMemo(
    () =>
      new Set(
        timetable.flatMap((stop) =>
          stop.lineStartTime ? [stop.lineStartTime] : [],
        ),
      ).size,
    [timetable],
  )
  const siriTripCount = useMemo(
    () => new Set(siriDepartureTimes).size,
    [siriDepartureTimes],
  )
  const targetScheduledTime = useMemo(
    () =>
      filters.departureTime
        ? jerusalemLocalToDate(
          filters.date,
          `${filters.departureTime}:00`,
        )
        : null,
    [filters.date, filters.departureTime],
  )
  const rides = useMemo(
    () =>
      targetScheduledTime
        ? buildRideOptions(locations, targetScheduledTime, comparisonRides)
        : [],
    [comparisonRides, locations, targetScheduledTime],
  )
  const selectableRides = useMemo(
    () =>
      rides.filter(
        (ride) => ride.relation === 'target' || ride.relation === 'unmarked',
      ),
    [rides],
  )
  const targetStops = useMemo(
    () => selectStopsForDeparture(timetable, filters.departureTime),
    [filters.departureTime, timetable],
  )
  const activeRideId = preferredTargetRideId(
    rides,
    filters.rideId,
    locations,
    targetStops,
  )
  const activeRide = rides.find((ride) => ride.id === activeRideId) ?? null
  const isToday = filters.date === jerusalemToday()
  const activeRideStatus = activeRide
    ? activeRide.pointCount > 0
      ? 'נתוני GPS זמינים'
      : isToday
        ? 'אין נתונים עדיין'
        : 'לא נצפתה ב-GPS / ייתכן שבוטלה'
    : null
  const activeRideSource = activeRide
    ? [
      'SIRI',
      ...(activeRide.sources.includes('gps')
        ? [isToday ? 'GPS חי' : 'GPS היסטורי']
        : []),
    ].join(' + ')
    : null
  const stops = useMemo(
    () =>
      activeRide?.scheduledStartTime
        ? stopsForSelectedRide(
          timetable,
          activeRide.scheduledStartTime,
          targetStops,
        )
        : targetStops,
    [activeRide, targetStops, timetable],
  )
  const points = useMemo(
    () =>
      locations.filter((location) => location.siriRideId === activeRideId),
    [activeRideId, locations],
  )
  const targetRideId = preferredTargetRideId(
    rides,
    null,
    locations,
    targetStops,
  )
  const targetPoints = useMemo(
    () =>
      targetRideId === null
        ? []
        : locations.filter((location) => location.siriRideId === targetRideId),
    [locations, targetRideId],
  )
  const routePreviewStops = useMemo(() => {
    const firstRideId = timetable.find((stop) => stop.gtfsRideId)?.gtfsRideId
    if (!firstRideId) return []
    return timetable.filter((stop) => stop.gtfsRideId === firstRideId)
  }, [timetable])
  const passages = useMemo(
    () => estimateStopPassages(stops, points, STOP_MATCH_THRESHOLD_METERS, rideStopOrders),
    [points, rideStopOrders, stops],
  )
  const targetPassages = useMemo(
    () =>
      estimateStopPassages(
        targetStops,
        targetPoints,
        STOP_MATCH_THRESHOLD_METERS,
        rideStopOrders,
      ),
    [rideStopOrders, targetPoints, targetStops],
  )
  const tripEvidence = useMemo(
    () =>
      targetScheduledTime
        ? analyzeTripEvidence({
          targetScheduledTime,
          siriRides: comparisonRides,
          rideOptions: rides,
          points: targetPoints,
          stops: targetStops,
          passages: targetPassages,
        })
        : null,
    [
      comparisonRides,
      rides,
      targetStops,
      targetPassages,
      targetPoints,
      targetScheduledTime,
    ],
  )
  const mapPassages = useMemo(
    () =>
      passages.length > 0
        ? passages
        : routePreviewStops.map((stop) => ({
          stop,
          stationCode: stop.code,
          point: null,
          distanceMeters: null,
          delayMinutes: null,
          confidence: null,
        })),
    [passages, routePreviewStops],
  )

  const handleFiltersChange = (nextFilters: SearchFilters) => {
    tripController.current?.abort()
    setFilters(nextFilters)
    setStatus('idle')
    setLocations([])
    setComparisonRides([])
    setRideStopOrders(new Map())
    setError(null)
  }

  const handleSheetPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    sheetDragCleanup.current?.()
    const startY = event.clientY
    const startHeight = sheetHeight

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const movement = startY - moveEvent.clientY
      setSheetHeight(clampSheetHeight(startHeight + movement))
    }

    const finishPointerDrag = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishPointerDrag)
      window.removeEventListener('pointercancel', finishPointerDrag)
      sheetDragCleanup.current = null
      setSheetDragging(false)
      setSheetHeight((current) => {
        if (current < window.innerHeight * 0.24) return MOBILE_SHEET_MIN_HEIGHT
        if (current > window.innerHeight * 0.78) return window.innerHeight - 16
        return current
      })
    }

    sheetDragCleanup.current = finishPointerDrag
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishPointerDrag)
    window.addEventListener('pointercancel', finishPointerDrag)
    setSheetDragging(true)
  }

  const handleSheetKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 96 : 40
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSheetHeight((current) => clampSheetHeight(current + step))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSheetHeight((current) => clampSheetHeight(current - step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setSheetHeight(MOBILE_SHEET_MIN_HEIGHT)
    } else if (event.key === 'End') {
      event.preventDefault()
      setSheetHeight(window.innerHeight - 16)
    }
  }

  return (
    <div className="app-shell">
      <main className="map-workspace">
        <section className="map-stage" aria-label="מפת קווי באר שבע ירוחם">
          <TripMap
            points={points}
            passages={mapPassages}
            selectedStopId={selectedStopId}
            onSelectStop={setSelectedStopId}
          />
        </section>

        <aside
          className={`control-sidebar${sheetDragging ? ' is-dragging' : ''}`}
          style={{
            '--sheet-height': `${sheetHeight}px`,
          } as CSSProperties}
        >
          <div className="sheet-resize-row">
            <div
              className="sheet-resize-handle"
              role="separator"
              aria-label="שינוי גובה חלונית המידע"
              aria-orientation="horizontal"
              aria-valuemin={Math.round((MOBILE_SHEET_MIN_HEIGHT / window.innerHeight) * 100)}
              aria-valuemax={98}
              aria-valuenow={Math.round((sheetHeight / window.innerHeight) * 100)}
              tabIndex={0}
              onPointerDown={handleSheetPointerDown}
              onKeyDown={handleSheetKeyDown}
              onDoubleClick={() =>
                setSheetHeight((current) =>
                  current > window.innerHeight * 0.7
                    ? clampSheetHeight(window.innerHeight * 0.46)
                    : window.innerHeight - 16,
                )
              }
            >
              <span aria-hidden="true" />
            </div>
            <button
              type="button"
              className={`sheet-size-toggle${sheetHeight > window.innerHeight * 0.7 ? ' is-expanded' : ''}`}
              aria-label={
                sheetHeight > window.innerHeight * 0.7
                  ? 'כווץ את חלונית המידע'
                  : 'הרחב את חלונית המידע'
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() =>
                setSheetHeight((current) =>
                  current > window.innerHeight * 0.7
                    ? MOBILE_SHEET_MIN_HEIGHT
                    : window.innerHeight - 16,
                )
              }
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6.5 14.5 5.5-5 5.5 5" />
              </svg>
            </button>
          </div>
          <header className="site-header">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">מ</span>
              <div>
                <strong>מדד הקו</strong>
                <span>מעקב נסיעות אוטובוס</span>
              </div>
            </div>
            <span className="data-badge"><i /> היסטורי</span>
          </header>

          <div className="sidebar-content">
            <section className={`sidebar-search${searchExpanded ? ' expanded' : ''}`}>
              <button
                type="button"
                className="search-toggle"
                aria-expanded={searchExpanded}
                onClick={() => setSearchExpanded((current) => !current)}
              >
                <span className="search-toggle-icon" aria-hidden="true">⌕</span>
                <span>
                  <strong>{searchExpanded ? 'איתור נסיעה' : `קו ${filters.line} · ${filters.departureTime}`}</strong>
                  <small>{searchExpanded ? 'בחרו תאריך, קו ושעת יציאה' : `${filters.date} · ${route.origin} ← ${route.destination}`}</small>
                </span>
                <i aria-hidden="true">⌄</i>
              </button>

              {searchExpanded && (
                <div className="search-body">
                  <section className="hero-copy">
                    <span className="eyebrow">קווים 150 / 152</span>
                    <h1>איפה האוטובוס היה?</h1>
                    <p>בחרו נסיעה בין באר שבע לירוחם וצפו במסלול ובתחנות.</p>
                  </section>

                  <SearchPanel
                    filters={filters}
                    departureOptions={departureOptions}
                    timetableLoading={timetableLoading}
                    timetableMessage={timetableMessage}
                    loading={status === 'loading'}
                    plannedTripCount={plannedTripCount}
                    siriTripCount={siriTripCount}
                    onChange={handleFiltersChange}
                    onSubmit={() => {
                      writeUrl(filters, true)
                      void loadTrip(filters)
                    }}
                  />
                </div>
              )}
            </section>

            {status === 'loading' && (
              <div className="state-banner loading-state" role="status">
                <span className="large-spinner" />
                <div>
                  <strong>מאתרים את הנסיעה…</strong>
                  <span>{isDelayed ? 'השרת מתעכב, הבקשה עדיין פעילה.' : 'מורידים את מסלול ה-GPS.'}</span>
                </div>
              </div>
            )}

            {status === 'error' && (
              <div className="state-banner error-state" role="alert">
                <span aria-hidden="true">!</span>
                <div><strong>לא הצלחנו לטעון</strong><p>{error}</p></div>
              </div>
            )}

            {status === 'empty' && (
              <div className="empty-state sidebar-empty">
                <strong>לא נמצאו תצפיות GPS לנסיעה</strong>
                <p>תחנות הקו עדיין מוצגות במפה.</p>
              </div>
            )}

            {status === 'success' && (
              <div className="sidebar-result">
                <section className="trip-title">
                  <div>
                    <span className="line-number">{route.line}</span>
                    <div><span className="eyebrow">נסיעה שנבחרה</span><h2>{route.origin} ← {route.destination}</h2></div>
                  </div>
                  <span className="point-count">{points.length} נקודות</span>
                </section>
                {activeRide && (
                  <dl className="bus-details-card">
                    <div>
                      <dt>לוחית רישוי</dt>
                      <dd dir="ltr">{activeRide.vehicleRef ?? 'לא ידועה'}</dd>
                    </div>
                    <div>
                      <dt>יציאה מתוכננת</dt>
                      <dd dir="ltr">{localTimeValue(activeRide.scheduledStartTime)}</dd>
                    </div>
                    <div>
                      <dt>SIRI ride ID</dt>
                      <dd dir="ltr">#{activeRide.id}</dd>
                    </div>
                    <div>
                      <dt>תצפיות GPS</dt>
                      <dd>{activeRide.pointCount}</dd>
                    </div>
                    <div>
                      <dt>מצב נתונים</dt>
                      <dd>{activeRideStatus}</dd>
                    </div>
                    <div>
                      <dt>מקור</dt>
                      <dd>
                        <span
                          className="data-source-label"
                          title={DATA_SOURCE_TOOLTIP}
                        >
                          {activeRideSource}
                        </span>
                      </dd>
                    </div>
                  </dl>
                )}
                <RideSelector
                  rides={selectableRides}
                  selectedRideId={activeRideId}
                  isToday={isToday}
                  onSelect={(rideId) => setFilters((current) => ({ ...current, rideId }))}
                />
                {tripEvidence && <EvidencePanel evidence={tripEvidence} />}
                <SummaryCards passages={passages} points={points} />
                <StopsTable
                  passages={passages}
                  selectedStopId={selectedStopId}
                  onSelectStop={setSelectedStopId}
                  compact
                />
                <details className="methodology">
                  <summary>איך מחושב זמן המעבר בתחנה?</summary>
                  <div>
                    <p>
                      ההתאמה משתמשת בסדר תחנות SIRI כדי לזהות את המעבר הנכון
                      במסלול. כשאין שיוך כזה נבחרת התצפית הראשונה שנכנסת לטווח{' '}
                      {STOP_MATCH_THRESHOLD_METERS} מטר, ולא תצפית מאוחרת וקרובה
                      יותר לאחר סיבוב בשכונה. זמן היציאה הוא התצפית הראשונה
                      בתחנת המוצא שמראה התקדמות ממשית במסלול; כך זמן ההמתנה
                      ברציף לא נחשב כיציאה מוקדמת.
                    </p>
                  </div>
                </details>
              </div>
            )}
          </div>

          <footer>
            <div>
              <a href="https://github.com/erezdaniel7/madad-hakav" target="_blank" rel="noreferrer">GitHub</a>
              <a href="https://open-bus-stride-api.hasadna.org.il/docs" target="_blank" rel="noreferrer">תיעוד API</a>
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
            </div>
            <span>נתונים: Open Bus · הסדנא לידע ציבורי</span>
          </footer>
        </aside>
      </main>
    </div>
  )
}

export default App
