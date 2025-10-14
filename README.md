# ORS TypeScript Client

> **Please note:**  
> This package is under development and testing.
> No results are guaranteed; evaluate whether it fits your use case before relying on it.

A TypeScript wrapper around the [openrouteservice API](https://openrouteservice.org/dev/#/api-docs) for Node.js projects.
It expects you to provide the API key via `process.env` or constructor options, ships with a rate limiter that follows the published restrictions,
and performs pre-flight validation to catch common mistakes early.

- Coverage: directions, isochrones, matrix, optimization, POIs, snap, geocoding, elevation
- Built-in rate limiting (40 requests/min by default, configurable)
- Validates documented constraints: waypoint counts, distances, areas, etc.
- Ships ESM and CommonJS bundles (`dist/index.mjs` and `dist/index.js`)
- Tested with [`vitest`](https://vitest.dev)

## Installation

```bash
npm install saas-ors-vpn
```

> Replace `saas-ors-vpn` with the package name you intend to publish, if needed.

## API key configuration

Two easy options:

1. **Pass it explicitly**

```ts
import { ORS } from 'saas-ors-vpn';

const ors = new ORS({ apiKey: process.env.ORS_API_KEY! });
```

2. **Expose an environment variable**

```text
# Exemple .env
ORS_API_KEY=your-ors-api-key
```

Chargez le fichier vous-meme (par exemple avec `import 'dotenv/config'` ou via votre orchestrateur) avant d'instancier le client.

## Quick start

```ts
import { ORS } from 'saas-ors-vpn';

const ors = new ORS({
  defaultProfile: 'driving-car'
});

const route = await ors.directions('driving-car', {
  coordinates: [
    [8.681495, 49.41461],
    [8.687872, 49.420318]
  ],
  instructions: false
});
```

### Isochrones

```ts
const isochrones = await ors.isochrones('driving-car', {
  locations: [[8.681495, 49.41461]],
  range: [600, 1200], // seconds
  attributes: ['area', 'reachfactor']
});
```

### Matrix

```ts
const matrix = await ors.matrix('driving-car', {
  locations: [
    [8.681495, 49.41461],
    [8.687872, 49.420318],
    [8.686507, 49.41943]
  ],
  metrics: ['duration']
});
```

### Geocoding

```ts
// geocodeTownZipLookup is exported from 'saas-ors-vpn'
const places = await ors.geocodeSearch({ text: 'FR, Paris, Rue de Rivoli' });
const reverse = await ors.geocodeReverse({
  point: { lat: 49.41461, lng: 8.681495 },
  layers: ['address']
});

const lookup = await geocodeTownZipLookup(ors, {
  town: 'Nice',
  zip: '06000',
  countryCode: 'FR'
});

if (lookup.coordinates) {
  console.log(`Best match from ${lookup.stage}`, lookup.coordinates);
}
```

## Rate limiting and restrictions

The implementation follows the values published at <https://openrouteservice.org/restrictions>:

- 40 requests per minute by default (override via `rateLimit`)
- Directions: 50 waypoints max, avoidance polygons limited to 200 km^2 area and 20 km extent
- Isochrones: up to 5 locations, 10 ranges, 120 km or 20 h depending on the profile
- Matrix: 3,500 cells max (50 x 50), 25 cells when using dynamic sources/destinations
- POIs, snap, optimization, and elevation include additional geometry checks

Need higher limits? Pass partial overrides:

```ts
const ors = new ORS({
  rateLimit: { requests: 120, intervalMs: 60_000 },
  limits: {
    matrix: { maxLocationsProduct: 10_000 },
    pois: { maxBboxAreaKm2: 100 }
  }
});
```

## API surface

| Method | Description |
| --- | --- |
| `directions(profile, body, options?)` | Routing (format json, geojson, or gpx) |
| `isochrones(profile, body, options?)` | Reachable areas |
| `matrix(profile, body, options?)` | Time/distance matrix |
| `optimization(body, options?)` | Vehicle routing problem solver |
| `snap(profile, body, options?)` | Snap to road / lightweight map matching |
| `pois(body, options?)` | Points of interest |
| `elevationPoint(body, options?)` | Elevation for a single point |
| `elevationLine(body, options?)` | Elevation profile for a linestring |
| `geocodeSearch(params, options?)` | Text search |
| `geocodeReverse(params, options?)` | Reverse geocoding |
| `geocodeAutocomplete(params, options?)` | Autocomplete suggestions |
| `geocodeStructured(params, options?)` | Structured geocoding |

Each method accepts optional request extras:

```ts
await ors.directions('driving-car', body, {
  signal: abortController.signal,
  axios: { timeout: 10_000 }
});
```

## npm scripts

- `npm run build` - bundles to `dist/` with `tsup`
- `npm run test` - runs the Vitest suite
- `npm run test:watch` - watch mode for development

## Development flow

```bash
npm install
cp .env.example .env   # set your ORS_API_KEY
npm test
```

Run the build before publishing:

```bash
npm run build
```

## License

ISC (adjust to your needs).

### Tools

| Helper | Description |
| --- | --- |
| `geocodeTownZipLookup(ors, query, options?)` | Chained lookup using town, zip, and country hints |
| `computeRouteProximity(route, coordinate, options?)` | Returns distance in km plus a tolerance check for a coordinate against a route geometry |
| `isCoordinateNearRoute(route, coordinate, toleranceKm?)` | Boolean shortcut that wraps `computeRouteProximity` |
| `planDeliveryTours(ors, request, options?)` | Heuristic clustering planner that combines matrix, isochrones, and directions data |
| `planDeliveryToursVRP(ors, request, options?)` | Optimization-based planner powered by the ORS VRP endpoint |

#### Route proximity helpers

```ts
import { computeRouteProximity, isCoordinateNearRoute } from 'saas-ors-vpn';

const routeGeoJson = /* GeoJSON FeatureCollection or LineString from an ORS directions call */;

const { distanceKm, isWithinTolerance } = computeRouteProximity(routeGeoJson, [8.68, 49.41], {
  toleranceKm: 0.25
});

if (!isCoordinateNearRoute(routeGeoJson, [8.68, 49.41], 0.1)) {
  console.warn('Client is outside the corridor');
}
```

#### Heuristic delivery tour planner

```ts
import { ORS, planDeliveryTours } from 'saas-ors-vpn';

const ors = new ORS({ apiKey: process.env.ORS_API_KEY!, defaultProfile: 'driving-hgv' });

const result = await planDeliveryTours(
  ors,
  {
    clients: [
      { name: 'Client 1', coordinate: [8.68, 49.41], weightKg: 200, orderDate: new Date() },
      { name: 'Client 2', coordinate: [8.70, 49.42], weightKg: 150, orderDate: new Date() }
    ],
    truckCapacityKg: 2_000,
    desiredTourCount: 1,
    depot: [8.65, 49.40]
  },
  {
    alongRouteToleranceKm: 0.2
  }
);

console.log(result.tours[0].estimatedDistanceKm);
```

#### VRP solver wrapper

```ts
import { ORS, planDeliveryToursVRP } from 'saas-ors-vpn';

const ors = new ORS({ apiKey: process.env.ORS_API_KEY!, defaultProfile: 'driving-hgv' });

const result = await planDeliveryToursVRP(ors, {
  clients: [
    { name: 'Client 1', coordinate: [8.68, 49.41], weightKg: 200, orderDate: new Date() },
    { name: 'Client 2', coordinate: [8.70, 49.42], weightKg: 150, orderDate: new Date() }
  ],
  truckCapacityKg: 2_000,
  desiredTourCount: 1,
  depot: [8.65, 49.40]
});

if (result.warnings.length) {
  console.warn(result.warnings.join('\n'));
}
```









