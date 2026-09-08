import { describe, expect, it } from 'vitest'
import type {
    SiriRideSummary,
    StopPassage,
    TimetableStop,
    VehicleLocation,
} from './types'
import {
    analyzeTripEvidence,
    buildRideOptions,
    preferredTargetRideId,
    routeAdherence,
    stopsForSelectedRide,
} from './tripAnalysis'

function point(
    id: number,
    scheduledStartTime: string,
    recordedAtTime: string,
    lat = 31.24,
    lon = 34.79,
): VehicleLocation {
    return {
        id,
        siriSnapshotId: id,
        siriRideStopId: null,
        recordedAtTime,
        lon,
        lat,
        bearing: null,
        velocity: null,
        distanceFromJourneyStart: id * 100,
        distanceFromRideStopMeters: null,
        snapshotRef: null,
        siriRouteId: 1,
        lineRef: 26156,
        operatorRef: 15,
        siriRideId: id < 10 ? 1 : 2,
        journeyRef: id < 10 ? 'target' : 'following',
        scheduledStartTime,
        vehicleRef: null,
        firstVehicleLocationId: null,
        lastVehicleLocationId: null,
        durationMinutes: null,
        gtfsRideId: null,
    }
}

const target = new Date('2026-08-30T14:00:00Z')

function ride(id: number, scheduledStartTime: string): SiriRideSummary {
    return {
        id,
        journeyRef: String(id),
        scheduledStartTime,
        vehicleRef: null,
        lineRef: 26200,
        operatorRef: 15,
    }
}

const stops: TimetableStop[] = [
    {
        id: 1,
        code: 1,
        name: 'A',
        city: null,
        lon: 34.79,
        lat: 31.24,
        plannedArrivalTime: '2026-08-30T14:00:00Z',
        lineRef: '26200',
        lineStartTime: '2026-08-30T14:00:00Z',
        gtfsRideId: '1',
    },
    {
        id: 2,
        code: 2,
        name: 'B',
        city: null,
        lon: 34.9,
        lat: 31.1,
        plannedArrivalTime: '2026-08-30T15:00:00Z',
        lineRef: '26200',
        lineStartTime: '2026-08-30T14:00:00Z',
        gtfsRideId: '1',
    },
]

const passages: StopPassage[] = stops.map((stop) => ({
    stop,
    stationCode: stop.code,
    point: null,
    distanceMeters: null,
    delayMinutes: null,
    confidence: null,
}))

describe('ride identity classification', () => {
    it('uses the exact planned stop times for a selected following ride', () => {
        const followingStops = stops.map((stop) => ({
            ...stop,
            id: stop.id + 10,
            gtfsRideId: 'following',
            lineStartTime: '2026-08-30T14:20:00Z',
            plannedArrivalTime:
                stop.id === 1
                    ? '2026-08-30T14:20:00Z'
                    : '2026-08-30T15:20:00Z',
        }))
        const selected = stopsForSelectedRide(
            [...stops, ...followingStops],
            '2026-08-30T14:20:00Z',
            stops,
        )
        expect(selected.map((stop) => stop.gtfsRideId)).toEqual([
            'following',
            'following',
        ])
        expect(selected[0].plannedArrivalTime).toBe('2026-08-30T14:20:00Z')
    })

    it('shifts the target stop pattern when a following timetable is absent', () => {
        const selected = stopsForSelectedRide(
            stops,
            '2026-08-30T14:20:00Z',
            stops,
        )
        expect(selected[0].plannedArrivalTime).toBe('2026-08-30T14:20:00.000Z')
        expect(selected[1].plannedArrivalTime).toBe('2026-08-30T15:20:00.000Z')
    })

    it('keeps a late observation attached to its scheduled target trip', () => {
        const options = buildRideOptions(
            [point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:25:00Z')],
            target,
        )
        expect(options[0].relation).toBe('target')
        expect(options[0].scheduleDeltaMinutes).toBe(0)
    })

    it('does not silently select a following scheduled trip', () => {
        const options = buildRideOptions(
            [point(10, '2026-08-30T14:20:00Z', '2026-08-30T14:25:00Z')],
            target,
        )
        expect(options[0].relation).toBe('following')
        expect(preferredTargetRideId(options, null)).toBeNull()
    })

    it('includes a SIRI target ride even when it has no GPS observations', () => {
        const options = buildRideOptions(
            [],
            target,
            [ride(1, '2026-08-30T14:00:00Z')],
        )

        expect(options).toEqual([
            expect.objectContaining({
                id: 1,
                relation: 'target',
                pointCount: 0,
                sources: ['siri'],
            }),
        ])
        expect(preferredTargetRideId(options, null)).toBe(1)
    })

    it('keeps a SIRI ride without a marked start time visible', () => {
        const unmarked = ride(3, '2026-08-30T14:00:00Z')
        unmarked.scheduledStartTime = null

        const options = buildRideOptions([], target, [unmarked])

        expect(options[0]).toEqual(
            expect.objectContaining({
                relation: 'unmarked',
                scheduledStartTime: null,
                pointCount: 0,
            }),
        )
    })

    it('scores a target safely before timetable stops are loaded', () => {
        const locations = [
            point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:25:00Z'),
        ]
        const options = buildRideOptions(locations, target)
        expect(preferredTargetRideId(options, null, locations, [])).toBe(1)
    })

    it('reports the target as unobserved when only a following trip exists', () => {
        const options = buildRideOptions(
            [point(10, '2026-08-30T14:20:00Z', '2026-08-30T14:25:00Z')],
            target,
        )
        const evidence = analyzeTripEvidence({
            targetScheduledTime: target,
            siriRides: [ride(2, '2026-08-30T14:20:00Z')],
            rideOptions: options,
            points: [],
            stops,
            passages,
        })
        expect(evidence.state).toBe('not-observed')
        expect(evidence.followingRides).toHaveLength(1)
    })

    it('keeps a metadata-only following ride separate from the target', () => {
        const evidence = analyzeTripEvidence({
            targetScheduledTime: target,
            siriRides: [ride(2, '2026-08-30T14:20:00Z')],
            rideOptions: [],
            points: [],
            stops,
            passages,
        })
        expect(evidence.state).toBe('not-observed')
        expect(evidence.targetRideIds).toHaveLength(0)
    })

    it('reports feed gaps on an otherwise observed target trip', () => {
        const points = [
            point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:02:00Z'),
            point(2, '2026-08-30T14:00:00Z', '2026-08-30T14:08:00Z'),
        ]
        const options = buildRideOptions(points, target)
        const evidence = analyzeTripEvidence({
            targetScheduledTime: target,
            siriRides: [ride(1, '2026-08-30T14:00:00Z')],
            rideOptions: options,
            points,
            stops,
            passages,
        })
        expect(evidence.state).toBe('feed-gap')
        expect(evidence.maxGapMinutes).toBe(6)
    })

    it('treats a trace that starts after the origin as incomplete evidence', () => {
        const points = [
            point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:32:00Z'),
            point(2, '2026-08-30T14:00:00Z', '2026-08-30T14:33:00Z'),
        ]
        const evidence = analyzeTripEvidence({
            targetScheduledTime: target,
            siriRides: [ride(1, '2026-08-30T14:00:00Z')],
            rideOptions: buildRideOptions(points, target),
            points,
            stops,
            passages,
        })

        expect(evidence.state).toBe('feed-gap')
        expect(evidence.originObservationMissing).toBe(true)
        expect(evidence.explanation).toContain('אין נתוני GPS מתחנת המוצא')
    })

    it('reports a prolonged stationary period without calling it a breakdown', () => {
        const points = [
            point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:00:00Z'),
            point(2, '2026-08-30T14:00:00Z', '2026-08-30T14:02:00Z'),
            point(3, '2026-08-30T14:00:00Z', '2026-08-30T14:04:00Z'),
        ]
        for (const item of points) {
            item.velocity = 0
            item.distanceFromJourneyStart = 100
        }
        const evidence = analyzeTripEvidence({
            targetScheduledTime: target,
            siriRides: [ride(1, '2026-08-30T14:00:00Z')],
            rideOptions: buildRideOptions(points, target),
            points,
            stops,
            passages,
        })
        expect(evidence.stalls).toHaveLength(1)
        expect(evidence.stalls[0].durationMinutes).toBe(4)
    })

    it('does not infer a stall across an observation gap', () => {
        const points = [
            point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:00:00Z'),
            point(2, '2026-08-30T14:00:00Z', '2026-08-30T14:05:00Z'),
        ]
        for (const item of points) {
            item.velocity = 0
            item.distanceFromJourneyStart = 100
        }
        const evidence = analyzeTripEvidence({
            targetScheduledTime: target,
            siriRides: [ride(1, '2026-08-30T14:00:00Z')],
            rideOptions: buildRideOptions(points, target),
            points,
            stops,
            passages,
        })
        expect(evidence.stalls).toHaveLength(0)
        expect(evidence.interruptions).toHaveLength(1)
    })

    it('scores endpoint coverage above raw point count for duplicate target rides', () => {
        const good = [
            point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:01:00Z', 31.24, 34.79),
            point(2, '2026-08-30T14:00:00Z', '2026-08-30T15:00:00Z', 31.1, 34.9),
        ]
        const noisy = Array.from({ length: 12 }, (_, index) =>
            point(
                10 + index,
                '2026-08-30T14:00:00Z',
                `2026-08-30T14:${String(index).padStart(2, '0')}:00Z`,
                32,
                35.8,
            ),
        )
        const locations = [...good, ...noisy]
        const options = buildRideOptions(locations, target)
        expect(preferredTargetRideId(options, null, locations, stops)).toBe(1)
    })
})

describe('route adherence', () => {
    it('requires three sustained off-route points', () => {
        const points = [
            point(1, '2026-08-30T14:00:00Z', '2026-08-30T14:01:00Z', 32, 35.8),
            point(2, '2026-08-30T14:00:00Z', '2026-08-30T14:02:00Z', 32, 35.8),
            point(3, '2026-08-30T14:00:00Z', '2026-08-30T14:03:00Z', 32, 35.8),
        ]
        expect(routeAdherence(points, stops).sustainedDeviationCount).toBe(1)
    })
})
