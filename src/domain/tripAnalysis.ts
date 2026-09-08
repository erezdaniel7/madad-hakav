import type {
    RideOption,
    SiriRideSummary,
    StopPassage,
    TimetableStop,
    TraceStall,
    TraceInterruption,
    TripEvidence,
    VehicleLocation,
} from './types'
import { distanceMeters } from '../utils/geo'
import { localTimeValue } from '../utils/time'

const TARGET_TOLERANCE_MS = 60_000
const FEED_GAP_MINUTES = 3
const OFF_ROUTE_THRESHOLD_METERS = 1_000
const SUSTAINED_DEVIATION_POINTS = 3

export function stopsForSelectedRide(
    timetable: readonly TimetableStop[],
    scheduledStartTime: string | null,
    fallbackStops: readonly TimetableStop[],
): TimetableStop[] {
    if (scheduledStartTime === null) return [...fallbackStops]
    const departureTime = localTimeValue(scheduledStartTime)
    const candidates = timetable.filter(
        (stop) =>
            stop.lineStartTime !== null &&
            localTimeValue(stop.lineStartTime) === departureTime,
    )
    const gtfsRideId = candidates[0]?.gtfsRideId
    if (gtfsRideId) {
        return candidates.filter((stop) => stop.gtfsRideId === gtfsRideId)
    }
    if (candidates.length > 0 || fallbackStops.length === 0) return candidates

    const fallbackStart = fallbackStops[0]?.lineStartTime
    if (!fallbackStart) return []
    const offset =
        new Date(scheduledStartTime).getTime() - new Date(fallbackStart).getTime()
    const shift = (timestamp: string | null): string | null =>
        timestamp === null
            ? null
            : new Date(new Date(timestamp).getTime() + offset).toISOString()
    return fallbackStops.map((stop) => ({
        ...stop,
        plannedArrivalTime: shift(stop.plannedArrivalTime),
        lineStartTime: shift(stop.lineStartTime),
    }))
}

export function buildRideOptions(
    locations: readonly VehicleLocation[],
    targetScheduledTime: Date,
    siriRides: readonly SiriRideSummary[] = [],
): RideOption[] {
    const rides = new Map<number, RideOption>()
    for (const ride of siriRides) {
        const scheduled = ride.scheduledStartTime
            ? new Date(ride.scheduledStartTime).getTime()
            : null
        const delta =
            scheduled === null
                ? 0
                : (scheduled - targetScheduledTime.getTime()) / 60_000
        const relation: RideOption['relation'] =
            scheduled === null
                ? 'unmarked'
                : Math.abs(scheduled - targetScheduledTime.getTime()) <= TARGET_TOLERANCE_MS
                    ? 'target'
                    : delta > 0
                        ? 'following'
                        : 'nearby'
        rides.set(ride.id, {
            id: ride.id,
            journeyRef: ride.journeyRef,
            scheduledStartTime: ride.scheduledStartTime,
            vehicleRef: ride.vehicleRef,
            pointCount: 0,
            scheduleDeltaMinutes: Math.round(delta),
            relation,
            sources: ['siri'],
        })
    }
    for (const location of locations) {
        const scheduled = new Date(location.scheduledStartTime).getTime()
        const delta = (scheduled - targetScheduledTime.getTime()) / 60_000
        const relation: RideOption['relation'] =
            Math.abs(scheduled - targetScheduledTime.getTime()) <= TARGET_TOLERANCE_MS
                ? 'target'
                : delta > 0
                    ? 'following'
                    : 'nearby'
        const existing = rides.get(location.siriRideId)
        if (existing) {
            existing.pointCount += 1
            if (!existing.sources.includes('gps')) existing.sources.push('gps')
            existing.vehicleRef ??= location.vehicleRef
            existing.journeyRef ??= location.journeyRef
            existing.scheduledStartTime ??= location.scheduledStartTime
        } else {
            rides.set(location.siriRideId, {
                id: location.siriRideId,
                journeyRef: location.journeyRef,
                scheduledStartTime: location.scheduledStartTime,
                vehicleRef: location.vehicleRef,
                pointCount: 1,
                scheduleDeltaMinutes: Math.round(delta),
                relation,
                sources: ['gps'],
            })
        }
    }
    return [...rides.values()].sort((a, b) => {
        const rank = { target: 0, unmarked: 1, following: 2, nearby: 3 }
        return (
            rank[a.relation] - rank[b.relation] ||
            Math.abs(a.scheduleDeltaMinutes) - Math.abs(b.scheduleDeltaMinutes) ||
            b.pointCount - a.pointCount
        )
    })
}

export function preferredTargetRideId(
    rides: readonly RideOption[],
    requestedRideId: number | null,
    locations: readonly VehicleLocation[] = [],
    stops: readonly TimetableStop[] = [],
): number | null {
    const requested = rides.find((ride) => ride.id === requestedRideId)
    if (requested) return requested.id
    const origin = stops.find((stop) => stop.lat !== null && stop.lon !== null)
    const destination = [...stops]
        .reverse()
        .find((stop) => stop.lat !== null && stop.lon !== null)
    const score = (ride: RideOption): number => {
        const points = locations
            .filter((point) => point.siriRideId === ride.id)
            .sort(
                (a, b) =>
                    new Date(a.recordedAtTime).getTime() -
                    new Date(b.recordedAtTime).getTime(),
            )
        let value = Math.min(ride.pointCount, 60) / 12
        if (ride.journeyRef) value += 2
        if (
            origin !== undefined &&
            origin.lat !== null &&
            origin.lon !== null &&
            points[0]
        ) {
            const distance = distanceMeters(
                { lat: origin.lat, lon: origin.lon },
                points[0],
            )
            value += Math.max(0, 3_000 - distance) / 100
        }
        if (
            destination !== undefined &&
            destination.lat !== null &&
            destination.lon !== null &&
            points.at(-1)
        ) {
            const distance = distanceMeters(
                { lat: destination.lat, lon: destination.lon },
                points.at(-1)!,
            )
            value += Math.max(0, 3_000 - distance) / 100
        }
        const progresses = points.flatMap((point) =>
            point.distanceFromJourneyStart === null
                ? []
                : [point.distanceFromJourneyStart],
        )
        if (
            progresses.length > 1 &&
            progresses.at(-1)! > progresses[0]
        ) {
            value += 5
        }
        return value
    }
    return (
        rides
            .filter((ride) => ride.relation === 'target')
            .map((ride) => ({ ride, score: score(ride) }))
            .sort((a, b) => b.score - a.score)[0]?.ride.id ?? null
    )
}

function traceInterruptions(
    points: readonly VehicleLocation[],
): TraceInterruption[] {
    const interruptions: TraceInterruption[] = []
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1]
        const current = points[index]
        const gapMinutes =
            (new Date(current.recordedAtTime).getTime() -
                new Date(previous.recordedAtTime).getTime()) /
            60_000
        if (gapMinutes <= FEED_GAP_MINUTES) continue
        const progressDeltaMeters =
            previous.distanceFromJourneyStart === null ||
                current.distanceFromJourneyStart === null
                ? null
                : current.distanceFromJourneyStart - previous.distanceFromJourneyStart
        interruptions.push({
            afterPointId: previous.id,
            beforePointId: current.id,
            gapMinutes,
            progressDeltaMeters,
        })
    }
    return interruptions
}

function traceStalls(points: readonly VehicleLocation[]): TraceStall[] {
    const stalls: TraceStall[] = []
    let start = 0
    for (let index = 1; index <= points.length; index += 1) {
        const previous = points[index - 1]
        const current = points[index]
        const sampleGapMilliseconds =
            current === undefined || previous === undefined
                ? Number.POSITIVE_INFINITY
                : new Date(current.recordedAtTime).getTime() -
                new Date(previous.recordedAtTime).getTime()
        const continues =
            current !== undefined &&
            previous !== undefined &&
            sampleGapMilliseconds <= 2 * 60_000 &&
            distanceMeters(previous, current) <= 80 &&
            (current.velocity ?? 0) <= 5
        if (continues) continue
        if (index - 1 > start) {
            const first = points[start]
            const last = points[index - 1]
            const durationMinutes =
                (new Date(last.recordedAtTime).getTime() -
                    new Date(first.recordedAtTime).getTime()) /
                60_000
            if (durationMinutes >= 3) {
                stalls.push({
                    fromPointId: first.id,
                    toPointId: last.id,
                    durationMinutes,
                    progressDeltaMeters:
                        first.distanceFromJourneyStart === null ||
                            last.distanceFromJourneyStart === null
                            ? null
                            : last.distanceFromJourneyStart -
                            first.distanceFromJourneyStart,
                })
            }
        }
        start = index
    }
    return stalls
}

function distanceToSegmentMeters(
    point: VehicleLocation,
    start: { lat: number; lon: number },
    end: { lat: number; lon: number },
): number {
    const latitude = ((start.lat + end.lat + point.lat) / 3) * (Math.PI / 180)
    const xScale = 111_320 * Math.cos(latitude)
    const yScale = 110_540
    const ax = start.lon * xScale
    const ay = start.lat * yScale
    const bx = end.lon * xScale
    const by = end.lat * yScale
    const px = point.lon * xScale
    const py = point.lat * yScale
    const dx = bx - ax
    const dy = by - ay
    const denominator = dx * dx + dy * dy
    const t =
        denominator === 0
            ? 0
            : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function routeAdherence(
    points: readonly VehicleLocation[],
    stops: readonly TimetableStop[],
): { offRoutePointCount: number; sustainedDeviationCount: number } {
    const coordinates = stops.flatMap((stop) =>
        stop.lat === null || stop.lon === null ? [] : [{ lat: stop.lat, lon: stop.lon }],
    )
    if (coordinates.length < 2 || points.length === 0) {
        return { offRoutePointCount: 0, sustainedDeviationCount: 0 }
    }
    const offRoute = points.map((point) => {
        let closest = Number.POSITIVE_INFINITY
        for (let index = 1; index < coordinates.length; index += 1) {
            closest = Math.min(
                closest,
                distanceToSegmentMeters(point, coordinates[index - 1], coordinates[index]),
            )
        }
        return closest > OFF_ROUTE_THRESHOLD_METERS
    })
    let run = 0
    let sustainedDeviationCount = 0
    for (let index = 0; index < offRoute.length; index += 1) {
        const isOffRoute = offRoute[index]
        if (index > 0) {
            const gap =
                new Date(points[index].recordedAtTime).getTime() -
                new Date(points[index - 1].recordedAtTime).getTime()
            if (gap > FEED_GAP_MINUTES * 60_000) run = 0
        }
        run = isOffRoute ? run + 1 : 0
        if (run === SUSTAINED_DEVIATION_POINTS) sustainedDeviationCount += 1
    }
    return {
        offRoutePointCount: offRoute.filter(Boolean).length,
        sustainedDeviationCount,
    }
}

export function analyzeTripEvidence({
    targetScheduledTime,
    siriRides,
    rideOptions,
    points,
    stops,
    passages,
}: {
    targetScheduledTime: Date
    siriRides: readonly SiriRideSummary[]
    rideOptions: readonly RideOption[]
    points: readonly VehicleLocation[]
    stops: readonly TimetableStop[]
    passages: readonly StopPassage[]
}): TripEvidence {
    const targetRideIds = siriRides
        .filter(
            (ride) =>
                ride.scheduledStartTime !== null &&
                Math.abs(
                    new Date(ride.scheduledStartTime).getTime() - targetScheduledTime.getTime(),
                ) <= TARGET_TOLERANCE_MS,
        )
        .map((ride) => ride.id)
    const targetObserved = rideOptions.some((ride) => ride.relation === 'target')
    const followingRides = rideOptions.filter((ride) => ride.relation === 'following')
    const followingScheduledRideCount = siriRides.filter(
        (ride) =>
            ride.scheduledStartTime !== null &&
            new Date(ride.scheduledStartTime).getTime() - targetScheduledTime.getTime() >
            TARGET_TOLERANCE_MS,
    ).length
    const interruptions = traceInterruptions(points)
    const stalls = traceStalls(points)
    const maxGapMinutes =
        interruptions.length === 0
            ? null
            : Math.max(...interruptions.map((item) => item.gapMinutes))
    const adherence = routeAdherence(points, stops)
    const targetVehicles = new Set(
        rideOptions
            .filter((ride) => ride.relation === 'target')
            .flatMap((ride) => (ride.vehicleRef ? [ride.vehicleRef] : [])),
    )

    let state: TripEvidence['state']
    let explanation: string
    const originObservationMissing =
        passages.length > 0 && !passages[0]?.point
    if (targetObserved && points.length >= 2) {
        state =
            interruptions.length > 0 || originObservationMissing
                ? 'feed-gap'
                : 'observed'
        explanation =
            originObservationMissing
                ? 'הנסיעה נצפתה רק בהמשך המסלול. אין נתוני GPS מתחנת המוצא, ולכן אי אפשר לקבוע את איחור היציאה.'
                : interruptions.length > 0
                ? 'הנסיעה נצפתה, אך רצף נתוני ה-GPS כולל פערים.'
                : 'הנסיעה המתוכננת נצפתה בנתוני ה-GPS.'
    } else if (targetRideIds.length > 0) {
        state = 'feed-gap'
        explanation =
            'קיימת רשומת נסיעת SIRI מתוכננת, אך לא התקבלו עבורה מספיק נקודות GPS.'
    } else if (followingRides.length > 0 || followingScheduledRideCount > 0) {
        state = 'not-observed'
        explanation =
            followingRides.length > 0
                ? 'נסיעת היעד לא נצפתה. נמצאו נסיעות מאוחרות יותר, אך הן אינן אותה נסיעה.'
                : 'נסיעת היעד לא נצפתה. קיימות זהויות לנסיעות מאוחרות יותר, וגם הן אינן הוכחה לביצוע נסיעת היעד.'
    } else if (siriRides.length === 0) {
        state = 'not-observed'
        explanation =
            'נסיעת היעד לא נצפתה ב-SIRI. אין בכך הוכחה שהנסיעה בוטלה בפועל.'
    } else {
        state = 'not-gps-verifiable'
        explanation = 'אין די נתוני GPS כדי לקבוע את ביצוע הנסיעה.'
    }

    return {
        state,
        targetRideIds,
        followingRides,
        maxGapMinutes,
        interruptions,
        stalls,
        targetVehicleCount: targetVehicles.size,
        ...adherence,
        originObservationMissing,
        destinationObservationMissing:
            passages.length > 0 && !passages.at(-1)?.point,
        explanation,
    }
}

export function closestStopDistance(
    point: VehicleLocation,
    stops: readonly TimetableStop[],
): number | null {
    const distances = stops.flatMap((stop) =>
        stop.lat === null || stop.lon === null
            ? []
            : [distanceMeters(point, { lat: stop.lat, lon: stop.lon })],
    )
    return distances.length > 0 ? Math.min(...distances) : null
}
