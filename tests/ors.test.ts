import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import nock from "nock"
import { ORS } from "../src/ors.js"

const BASE_URL = "https://api.openrouteservice.org"

describe("ORS client", () => {
	const originalEnvKey = process.env.ORS_API_KEY

	beforeAll(() => {
		nock.disableNetConnect()
	})

	afterAll(() => {
		if (originalEnvKey === undefined) {
			delete process.env.ORS_API_KEY
		} else {
			process.env.ORS_API_KEY = originalEnvKey
		}
		nock.enableNetConnect()
	})

	beforeEach(() => {
		process.env.ORS_API_KEY = "env-key"
	})

	afterEach(() => {
		nock.cleanAll()
	})

	it("throws when no API key is provided", () => {
		delete process.env.ORS_API_KEY
		expect(() => new ORS()).toThrow(/API key/)
	})

	it("uses the default base URL and version for directions", async () => {
		const scope = nock(BASE_URL)
			.matchHeader("Authorization", "test-key")
			.post("/v2/directions/driving-car/json", (body) => {
				expect(body.coordinates).toEqual([
					[8.681495, 49.41461],
					[8.687872, 49.420318],
				])
				return true
			})
			.reply(200, { routes: [{ summary: {} }] })

		const ors = new ORS({
			apiKey: "test-key",
			rateLimit: { enabled: false },
		})

		const response = await ors.directions("driving-car", {
			coordinates: [
				[8.681495, 49.41461],
				[8.687872, 49.420318],
			],
			instructions: false,
		})

		expect(response).toEqual({ routes: [{ summary: {} }] })
		expect(scope.isDone()).toBe(true)
	})

	it("throws when waypoint limit is exceeded", async () => {
		const ors = new ORS({
			apiKey: "test-key",
			rateLimit: { enabled: false },
		})

		const coordinates: [number, number][] = Array.from(
			{ length: 51 },
			(_, idx) => [8.6 + idx * 0.001, 49.4 + idx * 0.001] as [number, number]
		)

		await expect(ors.directions("driving-car", { coordinates })).rejects.toThrow(/waypoints limit/)
	})

	it("validates isochrone ranges", async () => {
		const ors = new ORS({
			apiKey: "test-key",
			rateLimit: { enabled: false },
		})

		await expect(
			ors.isochrones("driving-car", {
				locations: [[8.681495, 49.41461]],
				range: Array.from({ length: 11 }, (_, idx) => 300 * idx),
			})
		).rejects.toThrow(/range intervals limit/)
	})

	it("allows overriding documented limits", async () => {
		const scope = nock(BASE_URL)
			.matchHeader("Authorization", "test-key")
			.post("/v2/matrix/driving-car")
			.reply(200, { durations: [[0]] })

		const ors = new ORS({
			apiKey: "test-key",
			rateLimit: { enabled: false },
			limits: {
				matrix: { maxLocationsProduct: 4, maxDynamicLocations: 4 },
			},
		})

		const result = await ors.matrix("driving-car", {
			locations: [
				[8.681495, 49.41461],
				[8.687872, 49.420318],
			],
			sources: [0],
			destinations: [1],
		})

		expect(result).toEqual({ durations: [[0]] })
		expect(scope.isDone()).toBe(true)
	})

	it("performs geocode requests via GET", async () => {
		const scope = nock(BASE_URL)
			.matchHeader("Authorization", "test-key")
			.get("/v2/geocode/search")
			.query({ text: "Berlin" })
			.reply(200, { features: [] })

		const ors = new ORS({
			apiKey: "test-key",
			rateLimit: { enabled: false },
		})

		const response = await ors.geocodeSearch({ text: "Berlin" })
		expect(response).toEqual({ features: [] })
		expect(scope.isDone()).toBe(true)
	})

	it("updates the Authorization header after setApiKey", async () => {
		const scope = nock(BASE_URL)
			.matchHeader("Authorization", "new-key")
			.post("/v2/snap/driving-car")
			.reply(200, { snapped: true })

		const ors = new ORS({
			apiKey: "old-key",
			rateLimit: { enabled: false },
		})
		ors.setApiKey("new-key")

		const response = await ors.snap("driving-car", {
			locations: [
				[8.681495, 49.41461],
				[8.687872, 49.420318],
			],
		})

		expect(response).toEqual({ snapped: true })
		expect(scope.isDone()).toBe(true)
	})
})
