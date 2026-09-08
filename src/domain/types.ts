export type LineNumber = '150' | '152'
export type Direction = 'to-yeruham' | 'to-beersheva'

export interface RouteConfig {
  lineRef: number
  line: LineNumber
  direction: Direction
  origin: string
  destination: string
}

export interface TimetableStop {
  id: number
  code: number | null
  name: string | null
  city: string | null
  lon: number | null
  lat: number | null
  plannedArrivalTime: string | null
  lineRef: string | null
  lineStartTime: string | null
  gtfsRideId: string | null
}

export interface VehicleLocation {
  id: number
  siriSnapshotId: number
  siriRideStopId: number | null
  recordedAtTime: string
  lon: number
  lat: number
  bearing: number | null
  velocity: number | null
  distanceFromJourneyStart: number | null
  distanceFromRideStopMeters: number | null
  snapshotRef: string | null
  siriRouteId: number | null
  lineRef: number | null
  operatorRef: number | null
  siriRideId: number
  journeyRef: string | null
  scheduledStartTime: string
  vehicleRef: string | null
  firstVehicleLocationId: number | null
  lastVehicleLocationId: number | null
  durationMinutes: number | null
  gtfsRideId: string | null
}

export interface RideOption {
  id: number
  journeyRef: string | null
  scheduledStartTime: string | null
  vehicleRef: string | null
  pointCount: number
  scheduleDeltaMinutes: number
  relation: 'target' | 'following' | 'nearby' | 'unmarked'
  sources: ('siri' | 'gps')[]
}

export interface SiriRideSummary {
  id: number
  journeyRef: string | null
  scheduledStartTime: string | null
  vehicleRef: string | null
  lineRef: number | null
  operatorRef: number | null
}

export type EvidenceState =
  | 'observed'
  | 'not-observed'
  | 'feed-gap'
  | 'not-gps-verifiable'

export interface TraceInterruption {
  afterPointId: number
  beforePointId: number
  gapMinutes: number
  progressDeltaMeters: number | null
}

export interface TraceStall {
  fromPointId: number
  toPointId: number
  durationMinutes: number
  progressDeltaMeters: number | null
}

export interface TripEvidence {
  state: EvidenceState
  targetRideIds: number[]
  followingRides: RideOption[]
  maxGapMinutes: number | null
  interruptions: TraceInterruption[]
  stalls: TraceStall[]
  targetVehicleCount: number
  offRoutePointCount: number
  sustainedDeviationCount: number
  originObservationMissing: boolean
  destinationObservationMissing: boolean
  explanation: string
}

export type MatchConfidence = 'high' | 'medium' | 'low'

export interface StopPassage {
  stop: TimetableStop
  stationCode: number | null
  point: VehicleLocation | null
  distanceMeters: number | null
  delayMinutes: number | null
  confidence: MatchConfidence | null
}

export interface SiriRideStopInfo {
  order: number
  code: number | null
}

export interface SearchFilters {
  date: string
  line: LineNumber
  direction: Direction
  departureTime: string
  rideId: number | null
}
