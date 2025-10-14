import type { Feature, FeatureCollection, GeoJsonObject, MultiPolygon, Polygon, Position } from "geojson"
import { ORS } from "../ors.js"
import { DEFAULT_LIMITS, PROFILE_GROUPS } from "../constants.js"
import type { DirectionsProfile, IsochroneProfile, MatrixRequest, RequestOptions } from "../types.js"
import type { LonLat } from "../utils/geo.js"
import { haversineDistanceKm } from "../utils/geo.js"
import { computeRouteProximity } from "./routeProximity.js"

const MS_PER_DAY = 86_400_000
const KM_PER_M = 0.001
const SEC_PER_MIN = 60
const EPSILON = 1e-6

const resolveProfileGroup = (profile: DirectionsProfile): keyof typeof PROFILE_GROUPS | null => {
	for (const [group, profiles] of Object.entries(PROFILE_GROUPS) as Array<[keyof typeof PROFILE_GROUPS, string[]]>) {
		if (profiles.includes(profile)) {
			return group
		}
	}
	return null
}

export interface DeliveryClientInput {
	id?: string
	name: string
	coordinate: LonLat
	weightKg: number
	orderDate: string | Date
	urgent?: boolean
}

export interface TourPlanningRequest {
	clients: DeliveryClientInput[]
	truckCapacityKg: number
	desiredTourCount: number
	depot: LonLat
}

export interface TourScoringWeights {
	age: number
	distance: number
	cluster: number
	urgent: number
}

export interface TourPlanningLimits {
	matrixMaxCells?: number
	directionsMaxWaypoints?: number
	isochroneMaxLocations?: number
}

export interface TourPlanningOptions {
	profile?: DirectionsProfile
	isoRangeMinutes?: number
	maxIsoRequests?: number
	clusterRadiusKm?: number
	neighborRadiusKm?: number
	alongRouteToleranceKm?: number
	averageSpeedKmh?: number
	scoringWeights?: Partial<TourScoringWeights>
	referenceDate?: Date
	maxCandidatesPerTour?: number
	limits?: TourPlanningLimits
	matrixRequestOptions?: RequestOptions
	isochroneRequestOptions?: RequestOptions
	directionsRequestOptions?: RequestOptions
}

export interface PlannedClient extends DeliveryClientInput {
	id: string
	orderDate: Date
	urgent: boolean
	ageDays: number
	distanceFromDepotKm: number
	durationFromDepotMin: number
	neighborCount: number
	score: number
	seed?: boolean
	matrixIndex: number
}

export interface PlannedStop extends PlannedClient {
	insertionCostKm: number
	position: number
}

export interface PlannedTour {
	id: string
	stops: PlannedStop[]
	totalWeightKg: number
	estimatedDistanceKm: number
	estimatedDurationMin: number
	routeGeoJson?: FeatureCollection | Feature | GeoJsonObject
	warnings: string[]
}

export interface TourPlanningResult {
	tours: PlannedTour[]
	unassigned: PlannedClient[]
	warnings: string[]
	scoringWeights: TourScoringWeights
	createdAt: Date
}

interface MatrixResponse {
	distances?: number[][]
	durations?: number[][]
}

interface MatrixData {
	distancesKm: number[][]
	durationsMin: number[][]
	warnings: string[]
}

interface StandardizedClient extends PlannedClient {
	matrixIndex: number
}

interface BuildTourContext {
	seed: StandardizedClient
	stops: PlannedStop[]
	totalWeight: number
	warnings: string[]
	routeGeoJson?: FeatureCollection | Feature | GeoJsonObject
}

const DEFAULT_SCORING_WEIGHTS: TourScoringWeights = {
	age: 0.5,
	distance: 0.25,
	cluster: 0.15,
	urgent: 0.1,
}

const DEFAULT_OPTIONS: Required<
	Pick<
		TourPlanningOptions,
		| "profile"
		| "isoRangeMinutes"
		| "maxIsoRequests"
		| "clusterRadiusKm"
		| "neighborRadiusKm"
		| "alongRouteToleranceKm"
		| "averageSpeedKmh"
		| "maxCandidatesPerTour"
	>
> = {
	profile: "driving-hgv",
	isoRangeMinutes: 60,
	maxIsoRequests: 5,
	clusterRadiusKm: 35,
	neighborRadiusKm: 25,
	alongRouteToleranceKm: 8,
	averageSpeedKmh: 55,
	maxCandidatesPerTour: 40,
}

const normalizeCoordinate = (coordinate: LonLat, label: string): LonLat => {
	if (!Array.isArray(coordinate) || coordinate.length < 2) {
		throw new Error(`${label} must be a [lon, lat] pair.`)
	}
	const lon = Number(coordinate[0])
	const lat = Number(coordinate[1])
	if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
		throw new Error(`${label} must contain finite coordinates.`)
	}
	return [lon, lat]
}

const normalizeClient = (
	client: DeliveryClientInput,
	index: number,
	depot: LonLat,
	referenceDate: Date,
	averageSpeedKmh: number
): StandardizedClient => {
	const id = client.id ?? `client_${index + 1}`
	const coordinate = normalizeCoordinate(client.coordinate, `Client ${id} coordinate`)
	const orderDate = new Date(client.orderDate)
	if (Number.isNaN(orderDate.getTime())) {
		throw new Error(`Invalid orderDate for client "${id}".`)
	}
	const ageMs = Math.max(0, referenceDate.getTime() - orderDate.getTime())
	const ageDays = ageMs / MS_PER_DAY
	const distanceFromDepotKm = haversineDistanceKm(depot, coordinate)
	const durationFromDepotMin = (distanceFromDepotKm / averageSpeedKmh) * 60
	return {
		...client,
		id,
		coordinate,
		orderDate,
		urgent: Boolean(client.urgent),
		ageDays,
		distanceFromDepotKm,
		durationFromDepotMin,
		neighborCount: 0,
		score: 0,
		seed: false,
		matrixIndex: index + 1,
	}
}

const buildMatrix = async (
	ors: ORS,
	profile: DirectionsProfile,
	depot: LonLat,
	clients: StandardizedClient[],
	options: TourPlanningOptions,
	limits: TourPlanningLimits
): Promise<MatrixData> => {
	const matrixWarnings: string[] = []
	const locations: LonLat[] = [depot, ...clients.map((client) => client.coordinate)]
	const maxCells = limits.matrixMaxCells ?? DEFAULT_LIMITS.matrix.maxLocationsProduct
	const locationCount = locations.length
	const cellCount = locationCount * locationCount
	if (cellCount > maxCells) {
		matrixWarnings.push(`Matrix size ${cellCount} exceeds limit ${maxCells}. Falling back to haversine distances.`)
		return buildFallbackMatrix(locations, options.averageSpeedKmh ?? DEFAULT_OPTIONS.averageSpeedKmh, matrixWarnings)
	}
	const request: MatrixRequest = {
		locations,
		metrics: ["distance", "duration"],
	}
	try {
		const response = await ors.matrix<MatrixResponse>(profile, request, options.matrixRequestOptions)
		return normalizeMatrixResponse(
			response,
			locations,
			options.averageSpeedKmh ?? DEFAULT_OPTIONS.averageSpeedKmh,
			matrixWarnings
		)
	} catch (error) {
		matrixWarnings.push(`ORS matrix request failed (${(error as Error).message}). Using haversine fallback.`)
		return buildFallbackMatrix(locations, options.averageSpeedKmh ?? DEFAULT_OPTIONS.averageSpeedKmh, matrixWarnings)
	}
}

const buildFallbackMatrix = (locations: LonLat[], averageSpeedKmh: number, warnings: string[]): MatrixData => {
	const distancesKm: number[][] = []
	const durationsMin: number[][] = []
	for (let i = 0; i < locations.length; i += 1) {
		distancesKm[i] = []
		durationsMin[i] = []
		for (let j = 0; j < locations.length; j += 1) {
			if (i === j) {
				distancesKm[i][j] = 0
				durationsMin[i][j] = 0
			} else {
				const distance = haversineDistanceKm(locations[i], locations[j])
				distancesKm[i][j] = distance
				durationsMin[i][j] = (distance / averageSpeedKmh) * 60
			}
		}
	}
	warnings.push("Used haversine fallback for pairwise distances and durations.")
	return { distancesKm, durationsMin, warnings }
}

const normalizeMatrixResponse = (
	response: MatrixResponse,
	locations: LonLat[],
	averageSpeedKmh: number,
	warnings: string[]
): MatrixData => {
	const distancesKm: number[][] = []
	const durationsMin: number[][] = []
	const size = locations.length
	const rawDistances = response.distances
	const rawDurations = response.durations
	for (let i = 0; i < size; i += 1) {
		distancesKm[i] = []
		durationsMin[i] = []
		for (let j = 0; j < size; j += 1) {
			const distanceM = rawDistances?.[i]?.[j]
			const durationSec = rawDurations?.[i]?.[j]
			if (typeof distanceM === "number") {
				distancesKm[i][j] = distanceM * KM_PER_M
			} else {
				const fallback = haversineDistanceKm(locations[i], locations[j])
				distancesKm[i][j] = fallback
				warnings.push("Missing distance value in matrix response, used haversine estimate.")
			}
			if (typeof durationSec === "number") {
				durationsMin[i][j] = durationSec / SEC_PER_MIN
			} else {
				const distanceKm = distancesKm[i][j]
				durationsMin[i][j] = (distanceKm / averageSpeedKmh) * 60
				warnings.push("Missing duration value in matrix response, estimated from average speed.")
			}
		}
	}
	return { distancesKm, durationsMin, warnings }
}

const computeNeighborCounts = (clients: StandardizedClient[], matrix: MatrixData, neighborRadiusKm: number): void => {
	for (const client of clients) {
		let neighbors = 0
		for (const other of clients) {
			if (client.id === other.id) {
				continue
			}
			const distanceKm = matrix.distancesKm[client.matrixIndex]?.[other.matrixIndex]
			if (typeof distanceKm === "number" && distanceKm <= neighborRadiusKm) {
				neighbors += 1
			}
		}
		client.neighborCount = neighbors
	}
}

const updateClientBaseMetrics = (clients: StandardizedClient[], matrix: MatrixData): void => {
	for (const client of clients) {
		const distanceKm = matrix.distancesKm[0]?.[client.matrixIndex]
		const durationMin = matrix.durationsMin[0]?.[client.matrixIndex]
		if (typeof distanceKm === "number") {
			client.distanceFromDepotKm = distanceKm
		}
		if (typeof durationMin === "number") {
			client.durationFromDepotMin = durationMin
		}
	}
}

const computeScoring = (clients: StandardizedClient[], weights: TourScoringWeights): void => {
	const maxAge = Math.max(...clients.map((client) => client.ageDays), 0)
	const maxDistance = Math.max(...clients.map((client) => client.distanceFromDepotKm), 0)
	const maxNeighbors = Math.max(...clients.map((client) => client.neighborCount), 0)
	for (const client of clients) {
		const ageScore = maxAge > EPSILON ? client.ageDays / maxAge : 0
		const distanceScore = maxDistance > EPSILON ? client.distanceFromDepotKm / maxDistance : 0
		const clusterScore = maxNeighbors > 0 ? client.neighborCount / maxNeighbors : 0
		const urgentScore = client.urgent ? 1 : 0
		client.score =
			ageScore * weights.age +
			distanceScore * weights.distance +
			clusterScore * weights.cluster +
			urgentScore * weights.urgent
	}
}

const selectSeeds = (clients: StandardizedClient[], desiredCount: number): StandardizedClient[] => {
	const sorted = [...clients].sort((a, b) => b.score - a.score || b.ageDays - a.ageDays)
	const seeds: StandardizedClient[] = []
	for (const client of sorted) {
		if (client.weightKg <= 0) {
			continue
		}
		if (!seeds.some((seed) => seed.id === client.id)) {
			client.seed = true
			seeds.push(client)
		}
		if (seeds.length >= desiredCount) {
			break
		}
	}
	return seeds
}

const buildIsochrones = async (
	ors: ORS,
	profile: DirectionsProfile,
	seeds: StandardizedClient[],
	options: TourPlanningOptions,
	limits: TourPlanningLimits
): Promise<Record<string, FeatureCollection | Feature | GeoJsonObject | undefined>> => {
	const isoRangeMinutes = options.isoRangeMinutes ?? DEFAULT_OPTIONS.isoRangeMinutes
	if (isoRangeMinutes <= 0 || seeds.length === 0) {
		return {}
	}
	let isoProfile: IsochroneProfile
	try {
		isoProfile = ensureIsochroneProfile(profile)
	} catch {
		return {}
	}
	const effectiveLimit = limits.isochroneMaxLocations ?? DEFAULT_LIMITS.isochrones.maxLocations
	const maxRequests = Math.min(options.maxIsoRequests ?? DEFAULT_OPTIONS.maxIsoRequests, effectiveLimit)
	const results: Record<string, FeatureCollection | Feature | GeoJsonObject | undefined> = {}
	const profileGroup = resolveProfileGroup(isoProfile)
	const maxRangeMap = DEFAULT_LIMITS.isochrones.maxRangeTimeHoursByGroup
	const groupKey =
		profileGroup && profileGroup !== "wheelchair" && profileGroup in maxRangeMap
			? (profileGroup as keyof typeof maxRangeMap)
			: "driving"
	const maxRangeMinutes = (maxRangeMap[groupKey] ?? 1) * 60
	const rangeSeconds = Math.min(isoRangeMinutes, maxRangeMinutes) * SEC_PER_MIN
	for (let i = 0; i < seeds.length && i < maxRequests; i += 1) {
		const seed = seeds[i]
		try {
			const response = await ors.isochrones(
				isoProfile,
				{
					locations: [seed.coordinate],
					range_type: "time",
					range: [rangeSeconds],
				},
				options.isochroneRequestOptions
			)
			results[seed.id] = response as FeatureCollection | Feature | GeoJsonObject
		} catch (error) {
			results[seed.id] = undefined
		}
	}
	return results
}

const isPointInsideFeature = (
	geometry: FeatureCollection | Feature | GeoJsonObject | undefined,
	coordinate: LonLat
): boolean => {
	if (!geometry) {
		return false
	}
	switch (geometry.type) {
		case "FeatureCollection": {
			const collection = geometry as FeatureCollection
			return collection.features.some((feature) => isPointInsideFeature(feature, coordinate))
		}
		case "Feature": {
			const feature = geometry as Feature
			if (!feature.geometry) {
				return false
			}
			return isPointInsideFeature(feature.geometry as GeoJsonObject, coordinate)
		}
		case "Polygon": {
			return isPointInsidePolygon(geometry as Polygon, coordinate)
		}
		case "MultiPolygon": {
			const multi = geometry as MultiPolygon
			return multi.coordinates.some((polygon) =>
				isPointInsidePolygon(
					{
						type: "Polygon",
						coordinates: polygon,
					},
					coordinate
				)
			)
		}
		default:
			return false
	}
}

const isPointInsidePolygon = (polygon: Polygon, coordinate: LonLat): boolean => {
	const [lon, lat] = coordinate
	const [outerRing] = polygon.coordinates as Position[][]
	if (!outerRing) {
		return false
	}
	let inside = false
	for (let i = 0, j = outerRing.length - 1; i < outerRing.length; j = i, i += 1) {
		const xi = outerRing[i][0]
		const yi = outerRing[i][1]
		const xj = outerRing[j][0]
		const yj = outerRing[j][1]
		const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi
		if (intersect) {
			inside = !inside
		}
	}
	return inside
}

const bestInsertionIndex = (
	sequence: StandardizedClient[],
	candidate: StandardizedClient,
	matrix: MatrixData,
	lockFirst = false
): { index: number; costIncreaseKm: number } => {
	if (sequence.length === 0) {
		return { index: 0, costIncreaseKm: matrix.distancesKm[0][candidate.matrixIndex] }
	}
	let bestIndex = 0
	let bestCost = Number.POSITIVE_INFINITY
	for (let insertAt = 0; insertAt <= sequence.length; insertAt += 1) {
		if (lockFirst && insertAt === 0) {
			continue
		}
		const prevIndex = insertAt === 0 ? 0 : sequence[insertAt - 1].matrixIndex
		const nextIndex = insertAt === sequence.length ? 0 : sequence[insertAt]?.matrixIndex ?? 0
		const costIncrease =
			matrix.distancesKm[prevIndex][candidate.matrixIndex] +
			matrix.distancesKm[candidate.matrixIndex][nextIndex] -
			matrix.distancesKm[prevIndex][nextIndex]
		if (costIncrease < bestCost) {
			bestCost = costIncrease
			bestIndex = insertAt
		}
	}
	return { index: bestIndex, costIncreaseKm: bestCost }
}

const buildTour = (
	seed: StandardizedClient,
	candidates: Map<string, StandardizedClient>,
	matrix: MatrixData,
	capacityKg: number,
	options: Required<Pick<TourPlanningOptions, "clusterRadiusKm" | "maxCandidatesPerTour">>,
	isochrone?: FeatureCollection | Feature | GeoJsonObject
): BuildTourContext => {
	const stops: StandardizedClient[] = [seed]
	const plannedStops: PlannedStop[] = [
		{
			...seed,
			position: 1,
			insertionCostKm: matrix.distancesKm[0][seed.matrixIndex],
		},
	]
	let totalWeight = seed.weightKg
	const warnings: string[] = []
	const remaining = new Map(candidates)
	remaining.delete(seed.id)

	while (remaining.size > 0) {
		const feasible: Array<{
			client: StandardizedClient
			insertionIndex: number
			costKm: number
			priority: number
		}> = []
		for (const candidate of remaining.values()) {
			if (candidate.weightKg + totalWeight > capacityKg + EPSILON) {
				continue
			}
			if (isochrone && !isPointInsideFeature(isochrone, candidate.coordinate)) {
				const distanceToSeed =
					matrix.distancesKm[seed.matrixIndex]?.[candidate.matrixIndex] ??
					haversineDistanceKm(seed.coordinate, candidate.coordinate)
				if (distanceToSeed > options.clusterRadiusKm) {
					continue
				}
			}
			const { index, costIncreaseKm } = bestInsertionIndex(stops, candidate, matrix, true)
			const distanceToSeed =
				matrix.distancesKm[seed.matrixIndex]?.[candidate.matrixIndex] ??
				haversineDistanceKm(seed.coordinate, candidate.coordinate)
			const distanceScore =
				distanceToSeed <= options.clusterRadiusKm ? 1 : options.clusterRadiusKm / (distanceToSeed + EPSILON)
			const priority = candidate.score * distanceScore
			feasible.push({
				client: candidate,
				insertionIndex: index,
				costKm: costIncreaseKm,
				priority,
			})
		}
		if (feasible.length === 0) {
			break
		}
		feasible.sort((a, b) => {
			const scoreDiff = b.priority - a.priority
			if (Math.abs(scoreDiff) > EPSILON) {
				return scoreDiff
			}
			return a.costKm - b.costKm
		})
		const choice = feasible[0]
		if (!choice) {
			break
		}
		const client = choice.client
		stops.splice(choice.insertionIndex, 0, client)
		plannedStops.splice(choice.insertionIndex, 0, {
			...client,
			position: choice.insertionIndex + 1,
			insertionCostKm: Math.max(choice.costKm, 0),
		})
		totalWeight += client.weightKg
		remaining.delete(client.id)
		if (plannedStops.length >= options.maxCandidatesPerTour) {
			warnings.push(`Reached max candidates per tour constraint (${options.maxCandidatesPerTour}).`)
			break
		}
	}

	return {
		seed,
		stops: plannedStops.map((stop, index) => ({
			...stop,
			position: index + 1,
		})),
		totalWeight,
		warnings,
	}
}

const sumRouteMetrics = (tour: BuildTourContext, matrix: MatrixData): { distanceKm: number; durationMin: number } => {
	let distanceKm = 0
	let durationMin = 0
	let previousIndex = 0
	for (const stop of tour.stops) {
		const index = stop.matrixIndex
		distanceKm += matrix.distancesKm[previousIndex][index] ?? 0
		durationMin += matrix.durationsMin[previousIndex][index] ?? 0
		previousIndex = index
	}
	distanceKm += matrix.distancesKm[previousIndex][0] ?? 0
	durationMin += matrix.durationsMin[previousIndex][0] ?? 0
	return { distanceKm, durationMin }
}

const enrichWithDirections = async (
	ors: ORS,
	profile: DirectionsProfile,
	depot: LonLat,
	tour: BuildTourContext,
	options: TourPlanningOptions,
	limits: TourPlanningLimits
): Promise<FeatureCollection | Feature | GeoJsonObject | undefined> => {
	const directionsLimit = limits.directionsMaxWaypoints ?? DEFAULT_LIMITS.directions.maxWaypoints
	if (tour.stops.length + 2 > directionsLimit) {
		return undefined
	}
	const coordinates: LonLat[] = [depot, ...tour.stops.map((stop) => stop.coordinate), depot]
	try {
		const response = await ors.directions(
			profile,
			{
				coordinates,
				instructions: false,
				geometry: true,
				geometry_simplify: false,
				format: "geojson",
			},
			options.directionsRequestOptions
		)
		if (response && typeof response === "object" && "features" in response) {
			return response as FeatureCollection
		}
		return response as FeatureCollection | Feature | GeoJsonObject | undefined
	} catch {
		return undefined
	}
}

const injectAlongRouteClients = (
	tour: BuildTourContext,
	matrix: MatrixData,
	remaining: Map<string, StandardizedClient>,
	toleranceKm: number,
	capacityKg: number
): boolean => {
	if (!tour.routeGeoJson) {
		return false
	}
	const nearby: StandardizedClient[] = []
	for (const candidate of remaining.values()) {
		if (tour.stops.some((stop) => stop.id === candidate.id)) {
			continue
		}
		const result = computeRouteProximity(tour.routeGeoJson, candidate.coordinate, { toleranceKm })
		if (result.isWithinTolerance) {
			nearby.push(candidate)
		}
	}
	nearby.sort((a, b) => b.score - a.score)
	const stopsSequence = tour.stops.map((stop) => stop as StandardizedClient)
	let inserted = false
	for (const candidate of nearby) {
		if (candidate.weightKg + tour.totalWeight > capacityKg + EPSILON) {
			continue
		}
		const { index, costIncreaseKm } = bestInsertionIndex(stopsSequence, candidate, matrix, true)
		stopsSequence.splice(index, 0, candidate)
		tour.stops.splice(index, 0, {
			...candidate,
			insertionCostKm: Math.max(costIncreaseKm, 0),
			position: index + 1,
		})
		remaining.delete(candidate.id)
		tour.totalWeight += candidate.weightKg
		inserted = true
	}
	for (let i = 0; i < tour.stops.length; i += 1) {
		tour.stops[i].position = i + 1
	}
	return inserted
}

/**
 * Builds clustered delivery tours by combining ORS matrix, isochrone, and directions services with heuristics.
 * Useful for medium fleets that need quick proposals before running full optimization.
 * @param ors - Initialized ORS client used for upstream API calls.
 * @param request - Core planning input including depot, clients, capacity, and desired tours. Expected keys:
 *   - `clients`: Array of deliveries with `name`, `[lon,lat]` `coordinate`, `weightKg`, and `orderDate`; optional `id` and `urgent`.
 *   - `truckCapacityKg`: Maximum payload the vehicle can carry; enforced against cumulative client weights per tour.
 *   - `desiredTourCount`: Number of tours the heuristic tries to seed before filling with nearby clients.
 *   - `depot`: `[lon,lat]` coordinate used as origin/terminus for every tour and routing request.
 * @param options - Optional tuning knobs controlling heuristics, limits, and upstream requests. Supported keys:
 *   - `profile` (default `'driving-hgv'`): ORS directions profile applied to every matrix/isochrone/directions call.
 *   - `isoRangeMinutes` (default `60`): Travel time window for each seed isochrone; values above ORS caps are clamped.
 *   - `maxIsoRequests` (default `5`): Ceiling on isochrone calls per run to keep API usage within account limits.
 *   - `clusterRadiusKm` (default `35`): Maximum straight-line distance from a seed for non-isochrone candidates.
 *   - `neighborRadiusKm` (default `25`): Radius used when counting neighboring clients for score weighting.
 *   - `alongRouteToleranceKm` (default `8`): Corridor width used when injecting extra clients along the final route.
 *   - `averageSpeedKmh` (default `55`): Speed assumption for fallback durations and initial depot distance metrics.
 *   - `scoringWeights` (defaults `{ age:0.5, distance:0.25, cluster:0.15, urgent:0.1 }`): Partial override for score weights.
 *   - `referenceDate` (default `new Date()`): Timestamp used to compute client aging when prioritizing older orders.
 *   - `maxCandidatesPerTour` (default `40`): Safety cap on stops considered per tour before aborting further insertions.
 *   - `limits.matrixMaxCells`: Hard stop for matrix cell count before falling back to haversine estimates.
 *   - `limits.directionsMaxWaypoints`: Maximum waypoints allowed when asking ORS for detailed directions geometry.
 *   - `limits.isochroneMaxLocations`: Upper bound on the number of locations included in isochrone requests.
 *   - `matrixRequestOptions`: Extra request metadata (AbortSignal/Axios config) forwarded to `ors.matrix`.
 *   - `isochroneRequestOptions`: Additional options forwarded to `ors.isochrones`.
 *   - `directionsRequestOptions`: Additional options forwarded to `ors.directions`.
 * @returns Planned tours, unassigned clients, warnings, and scoring metadata.
 * @example
 * ```ts
 * const result = await planDeliveryTours(ors, {
 *   clients: [
 *     { name: 'Client 1', coordinate: [8.68, 49.41], weightKg: 200, orderDate: new Date() },
 *     { name: 'Client 2', coordinate: [8.70, 49.42], weightKg: 150, orderDate: new Date() }
 *   ],
 *   truckCapacityKg: 2_000,
 *   desiredTourCount: 1,
 *   depot: [8.65, 49.40]
 * }, {
 *   alongRouteToleranceKm: 0.2,
 *   profile: 'driving-hgv'
 * });
 * console.log(result.tours[0].estimatedDistanceKm);
 * ```
 */
export const planDeliveryTours = async (
	ors: ORS,
	request: TourPlanningRequest,
	options: TourPlanningOptions = {}
): Promise<TourPlanningResult> => {
	if (!request || !Array.isArray(request.clients) || request.clients.length === 0) {
		throw new Error("At least one client is required to plan tours.")
	}
	if (!Number.isFinite(request.truckCapacityKg) || request.truckCapacityKg <= 0) {
		throw new Error("Truck capacity must be a positive number.")
	}
	if (!Number.isInteger(request.desiredTourCount) || request.desiredTourCount <= 0) {
		throw new Error("desiredTourCount must be a positive integer.")
	}
	const depot = normalizeCoordinate(request.depot, "Depot coordinate")
	const mergedOptions = { ...DEFAULT_OPTIONS, ...options }
	const referenceDate = options.referenceDate ?? new Date()
	const weights: TourScoringWeights = {
		...DEFAULT_SCORING_WEIGHTS,
		...options.scoringWeights,
	}

	const normalizedClients = request.clients.map((client, index) =>
		normalizeClient(client, index, depot, referenceDate, mergedOptions.averageSpeedKmh)
	)

	const limits = options.limits ?? {}

	const matrix = await buildMatrix(ors, mergedOptions.profile, depot, normalizedClients, mergedOptions, limits)

	updateClientBaseMetrics(normalizedClients, matrix)

	computeNeighborCounts(normalizedClients, matrix, mergedOptions.neighborRadiusKm)
	computeScoring(normalizedClients, weights)

	const seeds = selectSeeds(normalizedClients, request.desiredTourCount)

	const isoGeometries = await buildIsochrones(ors, mergedOptions.profile, seeds, mergedOptions, limits)

	const remaining = new Map(normalizedClients.map((client) => [client.id, client]))
	const tours: PlannedTour[] = []
	const globalWarnings = [...matrix.warnings]

	for (const seed of seeds) {
		if (!remaining.has(seed.id)) {
			continue
		}
		const context = buildTour(
			seed,
			remaining,
			matrix,
			request.truckCapacityKg,
			{
				clusterRadiusKm: mergedOptions.clusterRadiusKm,
				maxCandidatesPerTour: mergedOptions.maxCandidatesPerTour,
			},
			isoGeometries[seed.id]
		)
		const routeGeometry = await enrichWithDirections(ors, mergedOptions.profile, depot, context, mergedOptions, limits)
		if (routeGeometry) {
			context.routeGeoJson = routeGeometry
		}
		const extended = injectAlongRouteClients(
			context,
			matrix,
			remaining,
			mergedOptions.alongRouteToleranceKm,
			request.truckCapacityKg
		)
		if (extended) {
			const refreshedGeometry = await enrichWithDirections(
				ors,
				mergedOptions.profile,
				depot,
				context,
				mergedOptions,
				limits
			)
			if (refreshedGeometry) {
				context.routeGeoJson = refreshedGeometry
			}
		}
		const metrics = sumRouteMetrics(context, matrix)
		tours.push({
			id: `tour_${tours.length + 1}`,
			stops: context.stops,
			totalWeightKg: context.totalWeight,
			estimatedDistanceKm: metrics.distanceKm,
			estimatedDurationMin: metrics.durationMin,
			routeGeoJson: context.routeGeoJson,
			warnings: context.warnings,
		})
		for (const stop of context.stops) {
			remaining.delete(stop.id)
		}
	}

	if (remaining.size > 0) {
		for (const client of remaining.values()) {
			if (client.weightKg > request.truckCapacityKg) {
				globalWarnings.push(`Client "${client.name}" exceeds truck capacity and remains unassigned.`)
			}
		}
		globalWarnings.push(`${remaining.size} client(s) remain unassigned after planning.`)
	}

	const unassigned = [...remaining.values()].sort((a, b) => b.score - a.score)

	return {
		tours,
		unassigned,
		warnings: globalWarnings,
		scoringWeights: weights,
		createdAt: referenceDate,
	}
}
const ensureIsochroneProfile = (profile: DirectionsProfile): IsochroneProfile => {
	if (profile === "wheelchair") {
		throw new Error("Wheelchair profile is not supported for isochrones.")
	}
	return profile as IsochroneProfile
}
