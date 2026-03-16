import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const d3 = require("../vendor/d3.v7.min.js");
const topojson = require("../vendor/topojson-client.3.min.js");
const Papa = require("../vendor/papaparse.5.4.1.min.js");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VIEWPORT = [975, 610];
const PRECISION = 4;
const EARTH_RADIUS_MILES = 3958.7613;

const rawStates = readJson("data/boundaries/states-census-2024-5m.geojson");
const usAtlasStates = readJson("data/boundaries/states-albers-10m.json");
const targetBounds = d3.geoPath().bounds(topojson.feature(usAtlasStates, usAtlasStates.objects.nation));
const rawAirportRows = parseCsv("data/source/ourairports-airports.csv");

const projection = d3.geoAlbersUsa().fitSize(VIEWPORT, rawStates);
const projectedStatesRaw = projectFeatureCollection(rawStates, projection, {
  featureId: (feature) => feature.properties?.STUSAB || feature.id,
});
const alignment = computeAlignmentTransform(d3.geoPath().bounds(projectedStatesRaw), targetBounds);

const airports = rawAirportRows
  .filter((row) => row.iso_country === "US" && row.scheduled_service === "yes")
  .map((row) => projectAirport(row, projection, alignment))
  .filter(Boolean)
  .sort((left, right) => left.code.localeCompare(right.code, undefined, { numeric: true, sensitivity: "base" }));

writeJson("data/overlays/us-scheduled-airports.json", {
  meta: {
    source: "OurAirports airports.csv",
    filter: "iso_country=US, scheduled_service=yes",
    count: airports.length,
    earthRadiusMiles: EARTH_RADIUS_MILES,
  },
  projection: {
    albersUsaScale: round(projection.scale()),
    albersUsaTranslate: projection.translate().map((value) => round(value)),
    alignScaleX: round(alignment.scaleX),
    alignScaleY: round(alignment.scaleY),
    alignTranslateX: round(alignment.translateX),
    alignTranslateY: round(alignment.translateY),
  },
  airports,
});

console.log(
  JSON.stringify(
    {
      count: airports.length,
      outputPath: "data/overlays/us-scheduled-airports.json",
    },
    null,
    2,
  ),
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(ROOT, relativePath), JSON.stringify(value), "utf8");
}

function parseCsv(relativePath) {
  const input = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  const result = Papa.parse(input, {
    header: true,
    skipEmptyLines: true,
  });

  if (result.errors?.length) {
    throw new Error(`Could not parse airport source CSV: ${result.errors[0].message}`);
  }

  return result.data;
}

function projectFeatureCollection(collection, projectionFn, options = {}) {
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => projectFeature(feature, projectionFn, options)).filter(Boolean),
  };
}

function projectFeature(feature, projectionFn, options) {
  const geometry = projectGeometry(feature.geometry, projectionFn);
  if (!geometry) {
    return null;
  }

  return {
    type: "Feature",
    id: options.featureId ? String(options.featureId(feature)) : feature.id,
    properties: feature.properties || {},
    geometry,
  };
}

function projectGeometry(geometry, projectionFn) {
  if (!geometry) {
    return null;
  }

  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates.map((ring) => projectRing(ring, projectionFn)).filter(Boolean);
    return rings.length ? { type: "Polygon", coordinates: rings } : null;
  }

  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates
      .map((polygon) => polygon.map((ring) => projectRing(ring, projectionFn)).filter(Boolean))
      .filter((polygon) => polygon.length);
    return polygons.length ? { type: "MultiPolygon", coordinates: polygons } : null;
  }

  return null;
}

function projectRing(ring, projectionFn) {
  const projected = ring.map((point) => projectPoint(point, projectionFn)).filter(Boolean);
  if (projected.length < 4) {
    return null;
  }

  const deduped = [projected[0]];
  for (let index = 1; index < projected.length; index += 1) {
    const previous = deduped[deduped.length - 1];
    const current = projected[index];
    if (previous[0] !== current[0] || previous[1] !== current[1]) {
      deduped.push(current);
    }
  }

  return deduped.length >= 4 ? deduped : null;
}

function computeAlignmentTransform(sourceBounds, targetBoundsInput) {
  const sourceWidth = sourceBounds[1][0] - sourceBounds[0][0];
  const sourceHeight = sourceBounds[1][1] - sourceBounds[0][1];
  const targetWidth = targetBoundsInput[1][0] - targetBoundsInput[0][0];
  const targetHeight = targetBoundsInput[1][1] - targetBoundsInput[0][1];

  return {
    scaleX: targetWidth / sourceWidth,
    scaleY: targetHeight / sourceHeight,
    translateX: targetBoundsInput[0][0] - sourceBounds[0][0] * (targetWidth / sourceWidth),
    translateY: targetBoundsInput[0][1] - sourceBounds[0][1] * (targetHeight / sourceHeight),
  };
}

function projectAirport(row, projectionFn, alignmentTransform) {
  const longitude = Number.parseFloat(row.longitude_deg);
  const latitude = Number.parseFloat(row.latitude_deg);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null;
  }

  const projected = projectPoint([longitude, latitude], projectionFn);
  if (!projected) {
    return null;
  }

  const [x, y] = transformPoint(projected, alignmentTransform);
  return {
    id: String(row.ident || row.gps_code || row.iata_code || row.local_code || row.name || "").trim(),
    code: String(row.iata_code || row.gps_code || row.local_code || row.ident || "").trim(),
    ident: String(row.ident || "").trim(),
    name: String(row.name || "").trim(),
    municipality: String(row.municipality || "").trim(),
    state_abbr: String(row.iso_region || "").split("-")[1] || "",
    type: String(row.type || "").trim(),
    latitude: round(latitude),
    longitude: round(longitude),
    x,
    y,
  };
}

function projectPoint(point, projectionFn) {
  const projected = projectionFn(point);
  if (!projected) {
    return null;
  }

  return [round(projected[0]), round(projected[1])];
}

function transformPoint(point, alignmentTransform) {
  return [
    round(point[0] * alignmentTransform.scaleX + alignmentTransform.translateX),
    round(point[1] * alignmentTransform.scaleY + alignmentTransform.translateY),
  ];
}

function round(value) {
  const factor = 10 ** PRECISION;
  return Math.round(value * factor) / factor;
}
