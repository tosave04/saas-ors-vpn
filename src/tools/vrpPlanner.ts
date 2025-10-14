import type { FeatureCollection, LineString } from "geojson"
import { DEFAULT_LIMITS } from "../constants.js"
import type { DirectionsProfile, OptimizationRequest, RequestOptions } from "../types.js"
import type { LonLat } from "../utils/geo.js"
import { haversineDistanceKm } from "../utils/geo.js"
import { ORS } from "../ors.js"
import type {
	DeliveryClientInput,
	PlannedClient,
	PlannedStop,
	PlannedTour,
	TourPlanningRequest,
} from "./tourPlanner.js"

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const MS_PER_DAY = 86_400_000
const DEFAULT_SERVICE_MINUTES = 20
const DEFAULT_PRIORITY_BASE = 60
const DEFAULT_PRIORITY_AGE_SCALE = 2
const DEFAULT_URGENT_PRIORITY_BOOST = 25
const DEFAULT_AVERAGE_SPEED_KMH = 55
const DEFAULT_SHIFT_HOURS = 10

interface OptimizationStep {
	type: "start" | "end" | "job" | "break"
	job?: number
	id?: number
	location?: LonLat
	arrival?: number
	duration?: number
	service?: number
	waiting_time?: number
	distance?: number
}

interface OptimizationRoute {
	vehicle: number
	distance?: number
	duration?: number
	cost?: number
	steps?: OptimizationStep[]
}

interface OptimizationUnassigned {
	id?: number
	job?: number
}

interface OptimizationSummary {
	cost?: number
	distance?: number
	duration?: number
}

interface OptimizationResponseLike {
	code?: number
	summary?: OptimizationSummary
	routes?: OptimizationRoute[]
	unassigned?: OptimizationUnassigned[]
	solution?: {
		routes?: OptimizationRoute[]
		unassigned?: OptimizationUnassigned[]
		summary?: OptimizationSummary
	}
}

interface NormalizedClient extends PlannedClient {
	jobId: number
	weightDemand: number
	priority: number
}

export interface VRPPlannerOptions {
	profile?: DirectionsProfile
	serviceTimeMinutes?: number
	priorityBase?: number
	priorityAgeScale?: number
	urgentPriorityBoost?: number
	averageSpeedKmh?: number
	shiftDurationHours?: number
	shiftStartSeconds?: number
	optimizationRequestOptions?: RequestOptions
}

export interface VRPPlanningResult {
	tours: PlannedTour[]
	unassigned: PlannedClient[]
	warnings: string[]
	createdAt: Date
	solver?: {
		vehiclesRequested: number
		vehiclesUsed: number
		cost?: number
		distanceKm?: number
		durationMin?: number
		code?: number
	}
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
	averageSpeedKmh: number,
	options: Pick<VRPPlannerOptions, "priorityBase" | "priorityAgeScale" | "urgentPriorityBoost">
): NormalizedClient => {
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
	const weightKg = Number(client.weightKg)
	if (!Number.isFinite(weightKg) || weightKg <= 0) {
		throw new Error(`Client "${id}" must have a positive weightKg.`)
	}
	const weightDemand = Math.max(1, Math.round(weightKg))
	const base = options.priorityBase ?? DEFAULT_PRIORITY_BASE
	const scale = options.priorityAgeScale ?? DEFAULT_PRIORITY_AGE_SCALE
	const urgentBoost = options.urgentPriorityBoost ?? DEFAULT_URGENT_PRIORITY_BOOST
	const ageAdjustment = Math.min(45, Math.round(ageDays * scale))
	let priority = base - ageAdjustment
	if (client.urgent) {
		priority -= urgentBoost
	}
	priority = Math.max(1, Math.min(100, priority))

	return {
		...client,
		id,
		orderDate,
		urgent: Boolean(client.urgent),
		coordinate,
		ageDays,
		distanceFromDepotKm,
		durationFromDepotMin,
		neighborCount: 0,
		score: ageDays,
		seed: false,
		matrixIndex: index + 1,
		jobId: index + 1,
		weightDemand,
		priority,
	}
}

const toServiceSeconds = (serviceMinutes?: number): number => {
	const minutes = Number.isFinite(serviceMinutes) ? (serviceMinutes as number) : DEFAULT_SERVICE_MINUTES
	return Math.max(0, Math.round(minutes * SECONDS_PER_MINUTE))
}

const createVehicleDescriptors = (
	count: number,
	depot: LonLat,
	capacityKg: number,
	profile: DirectionsProfile,
	shiftStartSeconds: number,
	shiftDurationSeconds: number
): Record<string, unknown>[] => {
	const capacityDemand = Math.max(1, Math.round(capacityKg))
	const vehicles: Record<string, unknown>[] = []
	for (let i = 0; i < count; i += 1) {
		vehicles.push({
			id: i + 1,
			profile,
			start: depot,
			end: depot,
			capacity: [capacityDemand],
			time_window: [shiftStartSeconds, shiftStartSeconds + shiftDurationSeconds],
			speed_factor: 1,
		})
	}
	return vehicles
}

const buildOptimizationRequest = (
	normalizedClients: NormalizedClient[],
	vehicles: Record<string, unknown>[],
	serviceSeconds: number
): OptimizationRequest => {
	const jobs = normalizedClients.map((client) => {
		const job: Record<string, unknown> = {
			id: client.jobId,
			name: client.name ?? client.id,
			location: client.coordinate,
			service: serviceSeconds,
			amount: [client.weightDemand],
			priority: client.priority,
		}
		if (client.urgent) {
			job.skills = [1]
		}
		return job
	})
	return {
		jobs,
		vehicles,
	}
}

const selectRoutes = (response: OptimizationResponseLike): OptimizationRoute[] => {
	if (Array.isArray(response.routes) && response.routes.length > 0) {
		return response.routes
	}
	if (response.solution?.routes && response.solution.routes.length > 0) {
		return response.solution.routes
	}
	return []
}

const selectUnassigned = (response: OptimizationResponseLike): OptimizationUnassigned[] => {
	if (Array.isArray(response.unassigned) && response.unassigned.length > 0) {
		return response.unassigned
	}
	if (response.solution?.unassigned && response.solution.unassigned.length > 0) {
		return response.solution.unassigned
	}
	return []
}

const metersToKm = (value?: number): number => (typeof value === "number" ? value / 1000 : 0)

const secondsToMinutes = (value?: number): number => (typeof value === "number" ? value / SECONDS_PER_MINUTE : 0)

const deriveRouteGeometry = (steps: OptimizationStep[]): LonLat[] => {
	const coordinates: LonLat[] = []
	for (const step of steps) {
		if (Array.isArray(step.location) && step.location.length >= 2) {
			coordinates.push([Number(step.location[0]), Number(step.location[1])])
		}
	}
	return coordinates
}

const buildStopsFromRoute = (
	route: OptimizationRoute,
	clientByJobId: Map<number, NormalizedClient>
): { stops: PlannedStop[]; totalWeight: number; jobIds: number[] } => {
	const steps = Array.isArray(route.steps) ? route.steps : []
	const stops: PlannedStop[] = []
	let totalWeight = 0
	let previousDistance = 0
	const jobIds: number[] = []

	for (const step of steps) {
		const jobId = step.job ?? step.id
		if (!jobId || !clientByJobId.has(jobId)) {
			previousDistance = step.distance ?? previousDistance
			continue
		}
		const client = clientByJobId.get(jobId) as NormalizedClient
		const insertionCostMeters =
			typeof step.distance === "number" && typeof previousDistance === "number"
				? Math.max(0, step.distance - previousDistance)
				: 0
		previousDistance = step.distance ?? previousDistance
		totalWeight += client.weightKg
		stops.push({
			...client,
			position: stops.length + 1,
			insertionCostKm: metersToKm(insertionCostMeters),
		})
		jobIds.push(jobId)
	}

	return { stops, totalWeight, jobIds }
}

const buildRouteGeoJson = (coordinates: LonLat[]) => {
	if (coordinates.length < 2) {
		return undefined
	}
	const geometry: LineString = {
		type: "LineString",
		coordinates,
	}
	const featureCollection: FeatureCollection<LineString> = {
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				properties: {},
				geometry,
			},
		],
	}
	return featureCollection
}

/**
 * Delegates delivery tour construction to the ORS optimization endpoint (VRP solver) with sensible defaults.
 * Ideal when you want solver-backed routes but still need structured application output.
 * @param ors - Initialized ORS client used to call the optimization endpoint.
 * @param request - Planning input including depot, clients, truck capacity, and requested vehicle count.
 * @param options - Optional solver tuning such as profile, service times, and shift configuration.
 * @returns Planned tours, unassigned clients, solver metadata, and warnings.
 * @example
 * ```ts
 * const vrpResult = await planDeliveryToursVRP(ors, {
 *   clients: [
 *     { name: 'Client 1', coordinate: [8.68, 49.41], weightKg: 200, orderDate: new Date() },
 *     { name: 'Client 2', coordinate: [8.70, 49.42], weightKg: 150, orderDate: new Date() }
 *   ],
 *   truckCapacityKg: 2_000,
 *   desiredTourCount: 2,
 *   depot: [8.65, 49.40]
 * }, {
 *   serviceTimeMinutes: 15,
 *   profile: 'driving-hgv'
 * });
 * console.log(vrpResult.tours.map((tour) => tour.stops.length));
 * ```
 */
export const planDeliveryToursVRP = async (
	ors: ORS,
	request: TourPlanningRequest,
	options: VRPPlannerOptions = {}
): Promise<VRPPlanningResult> => {
	if (!request || !Array.isArray(request.clients) || request.clients.length === 0) {
		throw new Error("At least one client is required to plan VRP tours.")
	}
	if (!Number.isFinite(request.truckCapacityKg) || request.truckCapacityKg <= 0) {
		throw new Error("Truck capacity must be a positive number.")
	}
	if (!Number.isInteger(request.desiredTourCount) || request.desiredTourCount <= 0) {
		throw new Error("desiredTourCount must be a positive integer.")
	}

	const depot = normalizeCoordinate(request.depot, "Depot coordinate")
	const referenceDate = new Date()
	const profile = options.profile ?? "driving-hgv"
	const averageSpeedKmh = options.averageSpeedKmh ?? DEFAULT_AVERAGE_SPEED_KMH
	const serviceSeconds = toServiceSeconds(options.serviceTimeMinutes)
	const shiftDurationHours = options.shiftDurationHours ?? DEFAULT_SHIFT_HOURS
	const shiftDurationSeconds = Math.max(SECONDS_PER_HOUR, Math.round(shiftDurationHours * SECONDS_PER_HOUR))
	const shiftStartSeconds = Math.max(0, options.shiftStartSeconds ?? 0)

	const normalizedClients = request.clients.map((client, index) =>
		normalizeClient(client, index, depot, referenceDate, averageSpeedKmh, options)
	)
	const clientByJobId = new Map<number, NormalizedClient>(normalizedClients.map((client) => [client.jobId, client]))

	const requestedVehicleCount = request.desiredTourCount
	const maxVehicles = DEFAULT_LIMITS.optimization.maxVehicles
	const vehicleCount = Math.min(requestedVehicleCount, maxVehicles)
	const warnings: string[] = []
	if (requestedVehicleCount > maxVehicles) {
		warnings.push(
			`Requested ${requestedVehicleCount} vehicles but optimization limit is ${maxVehicles}. Using ${vehicleCount} vehicle(s).`
		)
	}

	const vehicles = createVehicleDescriptors(
		vehicleCount,
		depot,
		request.truckCapacityKg,
		profile,
		shiftStartSeconds,
		shiftDurationSeconds
	)

	const optimizationRequest = buildOptimizationRequest(normalizedClients, vehicles, serviceSeconds)

	let response: OptimizationResponseLike
	try {
		response = await ors.optimization<OptimizationResponseLike>(optimizationRequest, options.optimizationRequestOptions)
	} catch (error) {
		throw new Error(`ORS optimization failed: ${(error as Error).message ?? "Unknown error"}`)
	}

	const routes = selectRoutes(response)
	const optimizationSummary = response.summary ?? response.solution?.summary
	const tours: PlannedTour[] = []
	const assignedJobIds = new Set<number>()

	for (const route of routes) {
		const { stops, totalWeight, jobIds } = buildStopsFromRoute(route, clientByJobId)
		for (const jobId of jobIds) {
			assignedJobIds.add(jobId)
		}
		const coordinates = deriveRouteGeometry(route.steps ?? [])
		const geometry = buildRouteGeoJson(coordinates)
		tours.push({
			id: `vrp_tour_${tours.length + 1}`,
			stops,
			totalWeightKg: totalWeight,
			estimatedDistanceKm: metersToKm(route.distance),
			estimatedDurationMin: secondsToMinutes(route.duration),
			routeGeoJson: geometry,
			warnings: [],
		})
	}

	const unassignedEntries = selectUnassigned(response)
	const unassignedClients: PlannedClient[] = []
	for (const entry of unassignedEntries) {
		const jobId = entry.job ?? entry.id
		if (!jobId) {
			continue
		}
		const client = clientByJobId.get(jobId)
		if (client) {
			unassignedClients.push(client)
			warnings.push(`Client "${client.name ?? client.id}" remains unassigned by the solver.`)
		}
	}

	for (const client of normalizedClients) {
		if (!assignedJobIds.has(client.jobId) && !unassignedClients.includes(client)) {
			unassignedClients.push(client)
			warnings.push(`Client "${client.name ?? client.id}" has no assigned route in the solver response.`)
		}
	}

	return {
		tours,
		unassigned: unassignedClients,
		warnings,
		createdAt: referenceDate,
		solver: {
			vehiclesRequested: requestedVehicleCount,
			vehiclesUsed: routes.length,
			cost: optimizationSummary?.cost,
			distanceKm: metersToKm(optimizationSummary?.distance),
			durationMin: secondsToMinutes(optimizationSummary?.duration),
			code: response.code,
		},
	}
}
